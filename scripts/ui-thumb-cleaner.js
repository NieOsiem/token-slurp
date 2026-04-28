import { MODULE_ID } from './constants.js';
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
 * @param {string}   storageRoot
 */
async function _regenerateThumbs(thumbData, storageRoot) {
  const safeRoot = storageRoot.replace(/\/+$/, '');

  const results = await Promise.allSettled(
    thumbData.map(async (item) => {
      // Safety check: ensure thumb path is within the expected storage root
      if (!item.thumb.startsWith(`${safeRoot}/`)) {
        console.error(`[${MODULE_ID}] Thumb cleaner refusing out-of-bounds path: ${item.thumb}`);
        return;
      }

      // Verify the source file exists before attempting regeneration
      try {
        const sourceDir  = item.source.substring(0, item.source.lastIndexOf('/'));
        const sourceName = item.source.split('/').pop();
        const result     = await FilePicker.browse('data', sourceDir);
        const exists     = (result.files ?? []).some(f => f.split('/').pop() === sourceName);
        if (!exists) {
          console.warn(`[${MODULE_ID}] Source file not found: ${item.source}`);
          return;
        }
      } catch (err) {
        console.warn(`[${MODULE_ID}] Could not verify source file ${item.source}:`, err);
        return;
      }

      // Regenerate the thumbnail from the source file
      // Pass force=true to ensureThumb to overwrite existing thumbnails
      await ensureThumb(item.source, item.thumb, true);
    })
  );

  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length) {
    console.warn(`[${MODULE_ID}] Thumb cleaner: ${failures.length} regeneration(s) failed:`);
    failures.forEach(r => console.warn(' >', r.reason));
  }
}
