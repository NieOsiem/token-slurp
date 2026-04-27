import { MODULE_ID, ANIMATION_OPTIONS } from './constants.js';
import { getSetting, SETTINGS } from './settings.js';
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
      this._animation  = 'none';
      this._duration   = 800;
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
      return {
        width:  cols * cw + 32,
        height: rows * ch + 90,
      };
    }

    async _prepareContext(_options) {
      return {};
    }

    async _onRender(_context, _options) {
      const el         = this.element;
      const cellWidth  = getSetting(SETTINGS.UI2_CELL_WIDTH);
      const cellHeight = getSetting(SETTINGS.UI2_CELL_HEIGHT);

      this._injectHeaderControls(el);

      const data = await buildGridData(this.tokenDoc);
      const container = el.querySelector('.ts-grid-container');
      if (!container) return;

      if (!data) {
        container.insertAdjacentHTML(
          'afterend',
          `<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.notifications.noImages')}</p>`
        );
        return;
      }

      this._files      = data.files;
      this._displayMap = data.displayMap;

      container.style.setProperty('--ts-cell-w', `${cellWidth}px`);
      container.style.setProperty('--ts-cell-h', `${cellHeight}px`);

      renderImageGrid({
        container,
        files:      this._files,
        displayMap: this._displayMap,
        currentSrc: data.currentSrc,
        cellWidth,
        cellHeight,
        cols:     null,   // css auto-fill
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

      // ── 1. Pin button ────────────────────────────────────────────────────
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

      // ── 2. Animation / duration controls ────────────────────────────────
      const controls = document.createElement('div');
      controls.className = 'ts-header-controls';
      controls.innerHTML = `
        <select class="ts-anim-select" title="${game.i18n.localize('TOKEN_SLURP.window.animation')}">
          ${ANIMATION_OPTIONS.map(o =>
            `<option value="${o.value}"${o.value === this._animation ? ' selected' : ''}>
              ${game.i18n.localize(o.label)}
            </option>`
          ).join('')}
        </select>
        <input class="ts-duration-slider" type="range" min="100" max="3000" step="100"
               value="${this._duration}"
               title="${game.i18n.localize('TOKEN_SLURP.window.duration')}"/>
        <span class="ts-duration-label">${this._duration}ms</span>
      `;

      const firstFoundryBtn = header.querySelector('.header-control, [data-action="close"]');
      if (firstFoundryBtn) header.insertBefore(controls, firstFoundryBtn);
      else header.appendChild(controls);

      controls.querySelector('.ts-anim-select').addEventListener('change', ev => {
        this._animation = ev.currentTarget.value;
      });

      const slider = controls.querySelector('.ts-duration-slider');
      const label  = controls.querySelector('.ts-duration-label');
      slider.addEventListener('input', ev => {
        this._duration = Number(ev.currentTarget.value);
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