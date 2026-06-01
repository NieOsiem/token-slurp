import { MODULE_ID, ANIMATION_OPTIONS, FLAGS } from './constants.js';
import { getSetting, setSetting, SETTINGS } from './settings.js';
import { getTokenFiles, switchTokenImage, renderImageGrid } from './grid.js';
import { resolveDisplayUrlsProgressive, shouldUseThumb } from './wildcard.js';

let _SlurpWindowClass = null;

export function initSlurpWindow() {
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  _SlurpWindowClass = class SlurpWindow extends HandlebarsApplicationMixin(ApplicationV2) {

    static _instances = new Map();

    static DEFAULT_OPTIONS = {
      id:      `${MODULE_ID}-window-{id}`,
      classes: ['token-slurp-window'],
      tag:     'div',
      window: {
        title:     'TOKEN_SLURP.window.title',
        resizable: true,
      },
      position: { width: 700, height: 540 },
    };

    static PARTS = {
      main: { template: `modules/${MODULE_ID}/templates/ui-window.hbs` },
    };

    constructor({ token }) {
      super();
      this.token               = token;
      this.tokenDoc            = token.document;
      this._files              = [];
      this._displayMap         = new Map();
      this._pinned             = false;
      this._animation          = getSetting(SETTINGS.UI2_ANIMATION);
      this._duration           = getSetting(SETTINGS.UI2_DURATION);
      this._tokenUpdateHookId  = null;
      this._deleteHookId       = null;
      this._refreshTimeout     = null;
      this._gridGeneration     = 0;
    }

    get title() {
      const base = game.i18n.localize('TOKEN_SLURP.window.title');
      const name = this.tokenDoc?.name;
      return name ? `${name} \u2014 ${base}` : base;
    }

    _syncTitle() {
      const el = this.element?.querySelector('.window-title');
      if (el) el.textContent = this.title;
    }

    _computeInitialSize() {
      const cw   = getSetting(SETTINGS.UI2_CELL_WIDTH);
      const ch   = getSetting(SETTINGS.UI2_CELL_HEIGHT);
      const cols = getSetting(SETTINGS.UI2_DEFAULT_COLS);
      const rows = getSetting(SETTINGS.UI2_DEFAULT_ROWS);

      const width  = cols * cw + (cols - 1) * 4 + 4 + 12 + 17 + 16;
      const height = rows * ch + (rows - 1) * 4 + 4 + 12 + 40 + 8;

      return { width, height };
    }

    async _prepareContext(_options) {
      return {};
    }

    async _onRender(_context, _options) {
      this._injectHeaderControls(this.element);
      await this._refreshGrid();
      this._registerUpdateHook();
      this._registerDeleteHook();
    }

    // ── Grid management ───────────────────────────────────────────────────────

    /**
     * Returns true if this.tokenDoc still exists in its parent scene's collection.
     * A stale doc (token deleted or teleported away) still lives as a JS object
     * in memory, so this is the only reliable way to detect it.
     */
    _isTokenValid() {
      return !!this.tokenDoc?.parent?.tokens?.has(this.tokenDoc.id);
    }

    async _refreshGrid(newTokenDoc = null) {
      const el = this.element;
      if (!el) return;

      if (newTokenDoc && newTokenDoc !== this.tokenDoc) {
        _SlurpWindowClass._instances.delete(this.tokenDoc.id);

        this.tokenDoc = newTokenDoc;
        this.token =
          canvas.tokens?.placeables.find(t => t.document === newTokenDoc)
          ?? this.token;

        _SlurpWindowClass._instances.set(this.tokenDoc.id, this);
      } else if (!newTokenDoc && !this._isTokenValid()) {
        this._gridGeneration++;
        const container = el.querySelector('.ts-grid-container');
        if (container) {
          container.innerHTML = `<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.notifications.tokenDeleted')}</p>`;
        }
        return;
      }

      this._syncTitle();

      const container = el.querySelector('.ts-grid-container');
      if (!container) return;

      container.innerHTML =
        `<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.window.loading')}</p>`;

      const tokenData = await getTokenFiles(this.tokenDoc);

      if (!tokenData) {
        container.innerHTML =
          `<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.notifications.noImages')}</p>`;
        return;
      }

      const { files, currentSrc, thumbMode } = tokenData;
      this._files      = files;
      this._displayMap = new Map();

      const generation = ++this._gridGeneration;

      const cellWidth       = getSetting(SETTINGS.UI2_CELL_WIDTH);
      const cellHeight      = getSetting(SETTINGS.UI2_CELL_HEIGHT);
      const zoom            = getSetting(SETTINGS.UI2_ZOOM);
      const zoomOrigin      = getSetting(SETTINGS.UI2_ZOOM_ORIGIN);
      const showMetaOverlay = getSetting(SETTINGS.UI2_SHOW_META_OVERLAY);

      const sharedGridOpts = {
        container,
        files,
        currentSrc,
        cellWidth,
        cellHeight,
        cols:        null,
        zoom,
        zoomOrigin,
        showMetaOverlay,
        onSelect: async (filePath) => {
          if (!this._isTokenValid()) {
            ui.notifications.warn(game.i18n.localize('TOKEN_SLURP.notifications.tokenDeleted'));
            return;
          }
          await switchTokenImage(this.tokenDoc, filePath, this._animation, this._duration);
          if (!this._pinned) this.close();
        },
      };

      if (!shouldUseThumb(files.length, thumbMode)) {
        renderImageGrid({ ...sharedGridOpts, displayMap: new Map(files.map(f => [f, f])) });
      } else {
        const { updateCellDisplay } = renderImageGrid({ ...sharedGridOpts, displayMap: new Map() });

        resolveDisplayUrlsProgressive(files, thumbMode, (filePath, url) => {
          if (this._gridGeneration !== generation) return;
          this._displayMap.set(filePath, url);
          updateCellDisplay(filePath, url);
        });
      }
    }

    // ── Token update reactions ────────────────────────────────────────────────

    _registerUpdateHook() {
      if (this._tokenUpdateHookId !== null) return;

      this._tokenUpdateHookId = Hooks.on('updateToken', (tokenDoc, changes) => {
        if (tokenDoc.id !== this.tokenDoc.id) return;

        const flagChanges = changes.flags?.[MODULE_ID];
        if (flagChanges &&
            (FLAGS.WILDCARD_PATH in flagChanges || FLAGS.WILDCARD_ACTIVE in flagChanges)) {
          clearTimeout(this._refreshTimeout);
          this._refreshTimeout = setTimeout(() => this._refreshGrid(), 100);
          return;
        }

        if ('name' in changes) this._syncTitle();

        if (changes.texture?.src) this._syncActiveCell(changes.texture.src);
      });
    }

    _registerDeleteHook() {
      if (this._deleteHookId !== null) return;

      this._deleteHookId = Hooks.on('deleteToken', (tokenDoc) => {
        if (tokenDoc.id !== this.tokenDoc.id) return;
        this._gridGeneration++;
        const container = this.element?.querySelector('.ts-grid-container');
        if (container) {
          container.innerHTML = `<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.notifications.tokenDeleted')}</p>`;
        }
      });
    }

    _syncActiveCell(src) {
      const container = this.element?.querySelector('.ts-grid-container');
      if (!container) return;
      container.querySelectorAll('.ts-cell--active')
               .forEach(c => c.classList.remove('ts-cell--active'));
      container.querySelector(`.ts-cell[data-src="${CSS.escape(src)}"]`)
               ?.classList.add('ts-cell--active');
    }

    // ── Header controls ───────────────────────────────────────────────────────

    _injectHeaderControls(el) {
      const header = el.querySelector('.window-header');
      if (!header || header.querySelector('.ts-header-controls')) return;

      const pinBtn = document.createElement('button');
      pinBtn.type      = 'button';
      pinBtn.className = `ts-pin-toggle${this._pinned ? ' ts-pinned' : ''}`;
      pinBtn.title     = game.i18n.localize('TOKEN_SLURP.window.pin');
      pinBtn.innerHTML = '<i class="fas fa-thumbtack"></i>';
      header.prepend(pinBtn);

      pinBtn.addEventListener('click', () => {
        this._pinned = !this._pinned;
        pinBtn.classList.toggle('ts-pinned', this._pinned);
      });

      const controls = document.createElement('div');
      controls.className = 'ts-header-controls';

      const reloadBtn = document.createElement('button');
      reloadBtn.type      = 'button';
      reloadBtn.className = 'ts-reload-btn';
      reloadBtn.title     = game.i18n.localize('TOKEN_SLURP.window.reloadSelected');
      reloadBtn.innerHTML = '<i class="fas fa-sync-alt"></i>';

      reloadBtn.addEventListener('click', async () => {
        const controlled = canvas.tokens?.controlled ?? [];
        const targetDoc  = controlled.length === 1
          ? controlled[0].document
          : this.tokenDoc;

        if (controlled.length !== 1 && !this._isTokenValid()) {
          ui.notifications.warn(game.i18n.localize('TOKEN_SLURP.notifications.tokenDeleted'));
          return;
        }

        const flags = targetDoc.flags?.[MODULE_ID] ?? {};
        if (!flags[FLAGS.WILDCARD_ACTIVE] || !flags[FLAGS.WILDCARD_PATH]) {
          ui.notifications.warn(game.i18n.localize('TOKEN_SLURP.notifications.noWildcard'));
          return;
        }

        await this._refreshGrid(targetDoc);
      });

      const followBtn = document.createElement('button');
      followBtn.type      = 'button';
      followBtn.className = 'ts-follow-btn';
      followBtn.title     = game.i18n.localize('TOKEN_SLURP.window.followScene');
      followBtn.innerHTML = '<i class="fas fa-map-marker-alt"></i>';

      followBtn.addEventListener('click', async () => {
        const myActorId = this.tokenDoc.actor?.id;
        const myPath    = this.tokenDoc.flags?.[MODULE_ID]?.[FLAGS.WILDCARD_PATH];

        if (!myActorId || !myPath) {
          ui.notifications.warn(game.i18n.localize('TOKEN_SLURP.notifications.followNoActor'));
          return;
        }

        const matches = (canvas.scene?.tokens ?? []).filter(td => {
          if (td.id === this.tokenDoc.id) return false;
          const sameActor = td.actor?.id === myActorId;
          const samePath  =
            td.flags?.[MODULE_ID]?.[FLAGS.WILDCARD_PATH] === myPath;
          return sameActor && samePath;
        });

        if (matches.length === 0) {
          ui.notifications.warn(game.i18n.localize('TOKEN_SLURP.notifications.followNoMatch'));
          return;
        }
        if (matches.length > 1) {
          ui.notifications.warn(game.i18n.localize('TOKEN_SLURP.notifications.followMultiple'));
          return;
        }

        await this._refreshGrid(matches[0]);
      });

      const sep = document.createElement('span');
      sep.className = 'ts-controls-sep';

      controls.innerHTML = `
        <input class="ts-duration-slider" type="range" min="100" max="3000" step="100"
               value="${this._duration}"
               title="${game.i18n.localize('TOKEN_SLURP.window.duration')}"/>
        <span class="ts-duration-label">${this._duration}ms</span>
        <select class="ts-anim-select" title="${game.i18n.localize('TOKEN_SLURP.window.animation')}">
          ${ANIMATION_OPTIONS.map(o =>
            `<option value="${o.value}"${o.value === this._animation ? ' selected' : ''}>
              ${game.i18n.localize(o.label)}
            </option>`
          ).join('')}
        </select>
      `;

      controls.prepend(sep, followBtn, reloadBtn);

      const firstFoundryBtn = header.querySelector('.header-control, [data-action="close"]');
      if (firstFoundryBtn) header.insertBefore(controls, firstFoundryBtn);
      else header.appendChild(controls);

      const select = controls.querySelector('.ts-anim-select');
      const slider = controls.querySelector('.ts-duration-slider');
      const label  = controls.querySelector('.ts-duration-label');

      const _stopEvent = (ev) => {
        ev.stopPropagation();
        ev.stopImmediatePropagation();
      };

      for (const el of [slider, select, reloadBtn, followBtn]) {
        el.addEventListener('pointerdown',  _stopEvent, { capture: true });
        el.addEventListener('mousedown',    _stopEvent, { capture: true });
        el.addEventListener('touchstart',   _stopEvent, { passive: false, capture: true });
        el.addEventListener('dragstart',    _stopEvent, { capture: true });
        el.addEventListener('selectstart',  _stopEvent, { capture: true });
        el.style.webkitAppRegion = 'no-drag';
      }

      const syncSliderVisibility = (value) => {
        const instant = value === 'none';
        slider.style.display = instant ? 'none' : '';
        label.style.display  = instant ? 'none' : '';
      };

      syncSliderVisibility(this._animation);

      select.addEventListener('change', ev => {
        this._animation = ev.currentTarget.value;
        setSetting(SETTINGS.UI2_ANIMATION, this._animation);
        syncSliderVisibility(this._animation);
      });

      slider.addEventListener('input', ev => {
        this._duration = Number(ev.currentTarget.value);
        setSetting(SETTINGS.UI2_DURATION, this._duration);
        label.textContent = `${this._duration}ms`;
      });
    }

    async _onClose(_options) {
      _SlurpWindowClass._instances.delete(this.tokenDoc.id);

      if (this._tokenUpdateHookId !== null) {
        Hooks.off('updateToken', this._tokenUpdateHookId);
        this._tokenUpdateHookId = null;
      }
      if (this._deleteHookId !== null) {
        Hooks.off('deleteToken', this._deleteHookId);
        this._deleteHookId = null;
      }
      clearTimeout(this._refreshTimeout);
    }
  };
}

export async function openSlurpWindow(token) {
  if (!_SlurpWindowClass) {
    console.error(`${MODULE_ID} | SlurpWindow class not ready.`);
    return;
  }
  const id       = token.document.id;
  const existing = _SlurpWindowClass._instances.get(id);
  if (existing) {
    existing.bringToFront();
    return;
  }

  const win = new _SlurpWindowClass({ token });
  _SlurpWindowClass._instances.set(id, win);
  await win.render({ force: true });

  win.setPosition(win._computeInitialSize());
}