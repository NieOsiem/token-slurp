import { MODULE_ID, ANIMATION_OPTIONS, FLAGS } from './constants.js';
import { getSetting, setSetting, SETTINGS } from './settings.js';
import { buildGridData, switchTokenImage, renderImageGrid } from './grid.js';

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
      this.token       = token;
      this.tokenDoc    = token.document;
      this._files      = [];
      this._displayMap = new Map();
      this._pinned     = false;
      this._animation  = getSetting(SETTINGS.UI2_ANIMATION);
      this._duration   = getSetting(SETTINGS.UI2_DURATION);
    }

    /**
     * Compute the window size from current settings.
     * Called by openSlurpWindow after render so the live setting values are used.
     * @returns {{ width: number, height: number }}
     */
    _computeInitialSize() {
      const cw   = getSetting(SETTINGS.UI2_CELL_WIDTH);
      const ch   = getSetting(SETTINGS.UI2_CELL_HEIGHT);
      const cols = getSetting(SETTINGS.UI2_DEFAULT_COLS);
      const rows = getSetting(SETTINGS.UI2_DEFAULT_ROWS);

      // Width:  cols*cw + (cols-1)*4 gaps + 4 grid-padding + 12 content-padding + 17 scrollbar + 16 chrome
      const width  = cols * cw + (cols - 1) * 4 + 4 + 12 + 17 + 16;
      // Height: rows*ch + (rows-1)*4 gaps + 4 grid-padding + 12 content-padding + 40 header + 8 chrome
      const height = rows * ch + (rows - 1) * 4 + 4 + 12 + 40 + 8;

      return { width, height };
    }

    async _prepareContext(_options) {
      return {};
    }

    async _onRender(_context, _options) {
      this._injectHeaderControls(this.element);
      await this._refreshGrid();
    }

    // ── Grid management ───────────────────────────────────────────────────────

    /**
     * Re-render the image grid in place, optionally switching to a different token.
     * Safe to call at any time after the window has been rendered.
     *
     * @param {TokenDocument|null} newTokenDoc
     *   Pass a different TokenDocument to switch the window to that token.
     *   Pass null (default) to simply refresh the current token's grid.
     */
    async _refreshGrid(newTokenDoc = null) {
      const el = this.element;
      if (!el) return;

      if (newTokenDoc && newTokenDoc.id !== this.tokenDoc.id) {
        _SlurpWindowClass._instances.delete(this.tokenDoc.id);

        this.tokenDoc = newTokenDoc;
        this.token =
          canvas.tokens?.placeables.find(t => t.document === newTokenDoc)
          ?? this.token;

        _SlurpWindowClass._instances.set(this.tokenDoc.id, this);
      }

      const container = el.querySelector('.ts-grid-container');
      if (!container) return;
      container.innerHTML =
        `<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.window.loading')}</p>`;

      const cellWidth  = getSetting(SETTINGS.UI2_CELL_WIDTH);
      const cellHeight = getSetting(SETTINGS.UI2_CELL_HEIGHT);
      const zoom       = getSetting(SETTINGS.UI2_ZOOM);
      const zoomOrigin = getSetting(SETTINGS.UI2_ZOOM_ORIGIN);

      const data = await buildGridData(this.tokenDoc);

      if (!data) {
        container.innerHTML =
          `<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.notifications.noImages')}</p>`;
        return;
      }

      this._files      = data.files;
      this._displayMap = data.displayMap;

      renderImageGrid({
        container,
        files:      this._files,
        displayMap: this._displayMap,
        currentSrc: data.currentSrc,
        cellWidth,
        cellHeight,
        cols:       null,   // css auto-fill
        zoom,
        zoomOrigin,
        onSelect: async (filePath) => {
          await switchTokenImage(this.tokenDoc, filePath, this._animation, this._duration);
          if (!this._pinned) this.close();
        },
      });
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