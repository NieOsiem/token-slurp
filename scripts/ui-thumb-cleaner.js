import { MODULE_ID, FLAGS } from './constants.js';
import { getSetting, SETTINGS } from './settings.js';
import { resolveWildcard, thumbPathFor, ensureThumb } from './wildcard.js';

export function initThumbCleaner() {
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  class ThumbCleanerApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
      id:      `${MODULE_ID}-thumb-cleaner`,
      classes: ['token-slurp-thumb-cleaner'],
      tag:     'div',
      window: {
        title:     'TOKEN_SLURP.thumbCleaner.title',
        resizable: false,
      },
      position: { width: 480, height: 'auto' },
    };

    static PARTS = {
      main: { template: `modules/${MODULE_ID}/templates/ui-thumb-cleaner.hbs` },
    };

    /** @type {AbortController|null} Cleans up preview-phase listeners on back/close */
    _previewAbort = null;

    async _prepareContext() {
      return {};
    }

    async _onRender(_ctx, _opts) {
      // Guard against re-binding on re-render
      const el = this.element;
      if (el.dataset.tsBound) return;
      el.dataset.tsBound = '1';
      this._bindSearchPhase(el);
    }

    async _onClose(_opts) {
      this._previewAbort?.abort();
    }

    // ── Phase 1 — search ──────────────────────────────────────────────────────

    _bindSearchPhase(el) {
      const pathInput  = el.querySelector('.ts-cleaner-path');
      const browseBtn  = el.querySelector('.ts-cleaner-browse');
      const findBtn    = el.querySelector('.ts-cleaner-find');
      const statusEl   = el.querySelector('.ts-cleaner-status');
      const searchDiv  = el.querySelector('.ts-cleaner-search');
      const previewDiv = el.querySelector('.ts-cleaner-preview');

      browseBtn.addEventListener('click', () => {
        new FilePicker({
          type:     'image',
          current:  pathInput.value || '',
          callback: (p) => { pathInput.value = p; },
        }).render(true);
      });

      findBtn.addEventListener('click', async () => {
        const rawPath = pathInput.value.trim();
        if (!rawPath) return;

        findBtn.disabled       = true;
        statusEl.textContent   = game.i18n.localize('TOKEN_SLURP.thumbCleaner.searching');
        statusEl.className     = 'ts-cleaner-status';
        statusEl.style.display = '';

        try {
          const storageRoot = getSetting(SETTINGS.THUMB_STORAGE_PATH);
          const files       = await resolveWildcard(rawPath);
          const thumbData   = await _findExistingThumbs(files, storageRoot);

          if (!thumbData.length) {
            statusEl.textContent = game.i18n.localize('TOKEN_SLURP.thumbCleaner.noneFound');
            findBtn.disabled = false;
            return;
          }

          statusEl.style.display = 'none';
          this._showPreviewPhase(el, thumbData, storageRoot, searchDiv, previewDiv, () => {
            statusEl.style.display = 'none';
            findBtn.disabled       = false;
          });

        } catch (err) {
          console.error(`[${MODULE_ID}] Thumb cleaner search error:`, err);
          statusEl.textContent = game.i18n.localize('TOKEN_SLURP.thumbCleaner.error');
          findBtn.disabled = false;
        }
      });
    }

    // ── Phase 2 — preview & confirm ───────────────────────────────────────────

    /**
     * Transition to the preview phase: show found thumbnails and a two-click regenerate button.
     * Uses an AbortController so all listeners are cleanly removed on Back or close.
     *
     * @param {HTMLElement}  el
     * @param {{source: string, thumb: string}[]} thumbData  — array of {source file path, thumbnail path}
     * @param {string}       storageRoot
     * @param {HTMLElement}  searchDiv
     * @param {HTMLElement}  previewDiv
     * @param {function}     onBack
     */
    _showPreviewPhase(el, thumbData, storageRoot, searchDiv, previewDiv, onBack) {
      // Abort any listeners left over from a previous preview visit
      this._previewAbort?.abort();
      const ac     = new AbortController();
      const signal = ac.signal;
      this._previewAbort = ac;

      const countEl   = previewDiv.querySelector('.ts-cleaner-count');
      const thumbGrid = previewDiv.querySelector('.ts-cleaner-thumb-grid');
      const backBtn   = previewDiv.querySelector('.ts-cleaner-back');
      const regenBtn  = previewDiv.querySelector('.ts-cleaner-regen');
      const regenLbl  = previewDiv.querySelector('.ts-cleaner-regen-label');

      countEl.textContent = game.i18n.format('TOKEN_SLURP.thumbCleaner.found', { count: thumbData.length });

      thumbGrid.innerHTML = '';
      for (const item of thumbData) {
        const img     = document.createElement('img');
        img.src       = item.thumb;
        img.title     = `${item.source} → ${item.thumb}`;
        img.loading   = 'lazy';
        img.className = 'ts-cleaner-thumb-preview';
        thumbGrid.appendChild(img);
      }

      regenBtn.disabled = false;
      regenBtn.classList.remove('ts-regen-confirm');
      regenLbl.textContent = game.i18n.format(
        'TOKEN_SLURP.thumbCleaner.regenCount', { count: thumbData.length }
      );

      searchDiv.style.display  = 'none';
      previewDiv.style.display = '';

      backBtn.addEventListener('click', () => {
        previewDiv.style.display = 'none';
        searchDiv.style.display  = '';
        ac.abort();
        onBack();
      }, { signal });

      // Regenerate — two-click confirmation
      let confirmed = false;
      regenBtn.addEventListener('click', async () => {
        if (!confirmed) {
          confirmed = true;
          regenBtn.classList.add('ts-regen-confirm');
          regenLbl.textContent = game.i18n.localize('TOKEN_SLURP.thumbCleaner.confirmRegen');
          return;
        }

        regenBtn.disabled = true;
        ac.abort();
        await _regenerateThumbs(thumbData, storageRoot);
        ui.notifications.info(
          game.i18n.format('TOKEN_SLURP.thumbCleaner.regenerated', { count: thumbData.length })
        );
        this.close();
      }, { signal });
    }
  }

  game.settings.registerMenu(MODULE_ID, 'thumbCleaner', {
    name:       'TOKEN_SLURP.settings.thumbCleaner.name',
    label:      'TOKEN_SLURP.settings.thumbCleaner.label',
    hint:       'TOKEN_SLURP.settings.thumbCleaner.hint',
    icon:       'fas fa-sync-alt',
    type:       ThumbCleanerApp,
    restricted: true, // GM only
  });

  // ── Rebuild every cached thumbnail ────────────────────────────────────────

  class ThumbRebuildApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
      id:      `${MODULE_ID}-thumb-rebuild`,
      classes: ['token-slurp-thumb-rebuild'],
      tag:     'div',
      window: {
        title:     'TOKEN_SLURP.thumbRebuild.title',
        resizable: false,
      },
      position: { width: 480, height: 'auto' },
    };

    static PARTS = {
      main: { template: `modules/${MODULE_ID}/templates/ui-thumb-rebuild.hbs` },
    };

    async _prepareContext() {
      return {};
    }

    async _onRender(_ctx, _opts) {
      const el = this.element;
      if (el.dataset.tsBound) return;
      el.dataset.tsBound = '1';

      const btn      = el.querySelector('.ts-rebuild-btn');
      const statusEl = el.querySelector('.ts-rebuild-status');
      let confirmed  = false;

      btn.addEventListener('click', async () => {
        if (!confirmed) {
          confirmed = true;
          btn.classList.add('ts-rebuild-confirm');
          btn.textContent = game.i18n.localize('TOKEN_SLURP.thumbRebuild.confirm');
          return;
        }

        confirmed = false;
        btn.disabled = true;
        btn.classList.remove('ts-rebuild-confirm');
        btn.textContent = game.i18n.localize('TOKEN_SLURP.thumbRebuild.button');
        statusEl.textContent = game.i18n.localize('TOKEN_SLURP.thumbRebuild.searching');

        try {
          const storageRoot = getSetting(SETTINGS.THUMB_STORAGE_PATH);
          const jobs        = await _collectAllThumbJobs(storageRoot);

          if (!jobs.length) {
            statusEl.textContent = game.i18n.localize('TOKEN_SLURP.thumbRebuild.none');
            btn.disabled = false;
            return;
          }

          statusEl.textContent = game.i18n.format('TOKEN_SLURP.thumbRebuild.progress', {
            done: 0, total: jobs.length,
          });

          const result = await _regenerateThumbs(jobs, storageRoot, (done, total) => {
            statusEl.textContent = game.i18n.format('TOKEN_SLURP.thumbRebuild.progress', { done, total });
          });

          const key = result.failed ? 'TOKEN_SLURP.thumbRebuild.partial' : 'TOKEN_SLURP.thumbRebuild.done';
          const msg = game.i18n.format(key, { count: result.done, failed: result.failed });
          statusEl.textContent = msg;
          ui.notifications.info(msg);
        } catch (err) {
          console.error(`[${MODULE_ID}] Rebuild-all error:`, err);
          statusEl.textContent = game.i18n.localize('TOKEN_SLURP.thumbRebuild.error');
        } finally {
          btn.disabled = false;
        }
      });
    }
  }

  game.settings.registerMenu(MODULE_ID, 'thumbRebuildAll', {
    name:       'TOKEN_SLURP.settings.thumbRebuild.name',
    label:      'TOKEN_SLURP.settings.thumbRebuild.label',
    hint:       'TOKEN_SLURP.settings.thumbRebuild.hint',
    icon:       'fas fa-eraser',
    type:       ThumbRebuildApp,
    restricted: true, // GM only
  });
}

// ── Rebuild-all helpers ───────────────────────────────────────────────────────

/**
 * Every wildcard path referenced by world tokens or actor prototype tokens.
 * @returns {Set<string>}
 */
function _collectWildcardPaths() {
  const paths = new Set();

  const add = (doc) => {
    const path = doc?.flags?.[MODULE_ID]?.[FLAGS.WILDCARD_PATH];
    if (path) paths.add(path);
  };

  for (const scene of game.scenes) {
    for (const token of scene.tokens) add(token);
  }
  for (const actor of game.actors) add(actor.prototypeToken);

  return paths;
}

/**
 * Pair every existing cached thumbnail with its source file.
 * Thumbnails for wildcard paths no longer referenced anywhere cannot be mapped
 * back to a source (the filename is a one-way hash) and are skipped.
 * @param {string} storageRoot
 * @returns {Promise<{source: string, thumb: string}[]>}
 */
async function _collectAllThumbJobs(storageRoot) {
  let existingNames;
  try {
    const result  = await FilePicker.browse('data', storageRoot);
    existingNames = new Set((result.files ?? []).map(f => f.split('/').pop()));
  } catch {
    return [];
  }

  const jobs = new Map();

  for (const path of _collectWildcardPaths()) {
    let files;
    try {
      files = await resolveWildcard(path);
    } catch (err) {
      console.warn(`[${MODULE_ID}] Rebuild-all: could not resolve ${path}:`, err);
      continue;
    }

    for (const source of files) {
      const thumb = thumbPathFor(source, storageRoot);
      if (existingNames.has(thumb.split('/').pop())) jobs.set(thumb, source);
    }
  }

  return [...jobs].map(([thumb, source]) => ({ source, thumb }));
}

// ── Module-private helpers ────────────────────────────────────────────────────

/**
 * Find which computed thumb paths actually exist on disk, and pair them with their source files.
 * Browses the storage root once, builds a Set of filenames, then does hash lookups.
 * @param {string[]} sourceFiles
 * @param {string}   storageRoot
 * @returns {Promise<{source: string, thumb: string}[]>}
 */
async function _findExistingThumbs(sourceFiles, storageRoot) {
  let existingNames;
  try {
    const result  = await FilePicker.browse('data', storageRoot);
    existingNames = new Set((result.files ?? []).map(f => f.split('/').pop()));
  } catch {
    // Storage directory doesn't exist yet — no thumbnails have been generated
    return [];
  }

  return sourceFiles
    .map(f => ({ source: f, thumb: thumbPathFor(f, storageRoot) }))
    .filter(item => existingNames.has(item.thumb.split('/').pop()));
}

/**
 * Regenerate thumbnail files from their source images.
 *
 * SAFETY: every thumbnail path is verified to start with `${storageRoot}/` before regeneration.
 * Source files are NEVER modified or overwritten.
 *
 * @param {{source: string, thumb: string}[]} thumbData
 * @param {string}    storageRoot
 * @param {function}  [onProgress] — (processed, total)
 * @returns {Promise<{done: number, failed: number}>}
 */
async function _regenerateThumbs(thumbData, storageRoot, onProgress = null) {
  const safeRoot = storageRoot.replace(/\/+$/, '');
  const total    = thumbData.length;
  const BATCH    = 8;
  let done = 0;
  let failed = 0;

  const runOne = async (item) => {
    // Safety check: ensure thumb path is within the expected storage root
    if (!item.thumb.startsWith(`${safeRoot}/`)) {
      console.error(`[${MODULE_ID}] Thumb cleaner refusing out-of-bounds path: ${item.thumb}`);
      failed++;
      return;
    }

    // ensureThumb falls back to the source path when loading/generation fails
    const url = await ensureThumb(item.source, item.thumb, true);
    if (url === item.thumb) done++;
    else {
      failed++;
      console.warn(`[${MODULE_ID}] Could not regenerate thumbnail for ${item.source}`);
    }
  };

  for (let i = 0; i < total; i += BATCH) {
    await Promise.all(thumbData.slice(i, i + BATCH).map(runOne));
    onProgress?.(Math.min(i + BATCH, total), total);
  }

  if (failed) {
    console.warn(`[${MODULE_ID}] Thumb regeneration: ${failed} of ${total} failed.`);
  }

  return { done, failed };
}
