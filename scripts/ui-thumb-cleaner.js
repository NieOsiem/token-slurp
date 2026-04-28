import { MODULE_ID } from './constants.js';
import { getSetting, SETTINGS } from './settings.js';
import { resolveWildcard, thumbPathFor } from './wildcard.js';

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
          const thumbPaths  = await _findExistingThumbs(files, storageRoot);

          if (!thumbPaths.length) {
            statusEl.textContent = game.i18n.localize('TOKEN_SLURP.thumbCleaner.noneFound');
            findBtn.disabled = false;
            return;
          }

          statusEl.style.display = 'none';
          this._showPreviewPhase(el, thumbPaths, storageRoot, searchDiv, previewDiv, () => {
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
     * Transition to the preview phase: show found thumbnails and a two-click delete button.
     * Uses an AbortController so all listeners are cleanly removed on Back or close.
     *
     * @param {HTMLElement}  el
     * @param {string[]}     thumbPaths
     * @param {string}       storageRoot
     * @param {HTMLElement}  searchDiv
     * @param {HTMLElement}  previewDiv
     * @param {function}     onBack
     */
    _showPreviewPhase(el, thumbPaths, storageRoot, searchDiv, previewDiv, onBack) {
      // Abort any listeners left over from a previous preview visit
      this._previewAbort?.abort();
      const ac     = new AbortController();
      const signal = ac.signal;
      this._previewAbort = ac;

      const countEl   = previewDiv.querySelector('.ts-cleaner-count');
      const thumbGrid = previewDiv.querySelector('.ts-cleaner-thumb-grid');
      const backBtn   = previewDiv.querySelector('.ts-cleaner-back');
      const deleteBtn = previewDiv.querySelector('.ts-cleaner-delete');
      const deleteLbl = previewDiv.querySelector('.ts-cleaner-delete-label');

      countEl.textContent = game.i18n.format('TOKEN_SLURP.thumbCleaner.found', { count: thumbPaths.length });

      thumbGrid.innerHTML = '';
      for (const p of thumbPaths) {
        const img     = document.createElement('img');
        img.src       = p;
        img.title     = p;
        img.loading   = 'lazy';
        img.className = 'ts-cleaner-thumb-preview';
        thumbGrid.appendChild(img);
      }

      deleteBtn.disabled = false;
      deleteBtn.classList.remove('ts-delete-confirm');
      deleteLbl.textContent = game.i18n.format(
        'TOKEN_SLURP.thumbCleaner.deleteCount', { count: thumbPaths.length }
      );

      searchDiv.style.display  = 'none';
      previewDiv.style.display = '';

      backBtn.addEventListener('click', () => {
        previewDiv.style.display = 'none';
        searchDiv.style.display  = '';
        ac.abort();
        onBack();
      }, { signal });

      // Delete — two-click confirmation
      let confirmed = false;
      deleteBtn.addEventListener('click', async () => {
        if (!confirmed) {
          confirmed = true;
          deleteBtn.classList.add('ts-delete-confirm');
          deleteLbl.textContent = game.i18n.localize('TOKEN_SLURP.thumbCleaner.confirmDelete');
          return;
        }

        deleteBtn.disabled = true;
        ac.abort();
        await _deleteThumbs(thumbPaths, storageRoot);
        ui.notifications.info(
          game.i18n.format('TOKEN_SLURP.thumbCleaner.deleted', { count: thumbPaths.length })
        );
        this.close();
      }, { signal });
    }
  }

  game.settings.registerMenu(MODULE_ID, 'thumbCleaner', {
    name:       'TOKEN_SLURP.settings.thumbCleaner.name',
    label:      'TOKEN_SLURP.settings.thumbCleaner.label',
    hint:       'TOKEN_SLURP.settings.thumbCleaner.hint',
    icon:       'fas fa-trash-alt',
    type:       ThumbCleanerApp,
    restricted: true, // GM only
  });
}

// ── Module-private helpers ────────────────────────────────────────────────────

/**
 * Find which computed thumb paths actually exist on disk.
 * Browses the storage root once, builds a Set of filenames, then does hash lookups.
 * @param {string[]} sourceFiles
 * @param {string}   storageRoot
 * @returns {Promise<string[]>}
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
    .map(f    => thumbPathFor(f, storageRoot))
    .filter(p => existingNames.has(p.split('/').pop()));
}

/**
 * Delete thumbnail files.
 *
 * SAFETY: every path is verified to start with `${storageRoot}/` before deletion.
 *
 * @param {string[]} thumbPaths
 * @param {string}   storageRoot
 */
async function _deleteThumbs(thumbPaths, storageRoot) {
  const safeRoot = storageRoot.replace(/\/+$/, '');

  const results = await Promise.allSettled(
    thumbPaths.map(async (p) => {
      if (!p.startsWith(`${safeRoot}/`)) {
        console.error(`[${MODULE_ID}] Thumb cleaner refusing out-of-bounds path: ${p}`);
        return;
      }
      await _deleteFile('data', p);
    })
  );

  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length) {
    console.warn(`[${MODULE_ID}] Thumb cleaner: ${failures.length} deletion(s) failed:`);
    failures.forEach(r => console.warn(' >', r.reason));
  }
}

/**
 * Delete a single file from Foundry's data storage.
 * @param {string} source  — storage source (always 'data' for user content)
 * @param {string} path    — relative path to the file
 * @returns {Promise<void>}
 * TODO: Fix the deletion mechanism cause it doesn't work and this renders this entire part useless XD
 */
async function _deleteFile(source, path) {
  const response = await fetch('/api/filesystems', {
    method:  'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ storage: source, path }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${response.status} ${response.statusText}`);
  }
}
