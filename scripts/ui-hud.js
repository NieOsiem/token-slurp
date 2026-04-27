import { MODULE_ID } from './constants.js';
import { getSetting, SETTINGS } from './settings.js';
import { buildGridData, switchTokenImage, renderImageGrid } from './grid.js';

/**
 * UI1 — lightweight panel on token hud
 */
export class HudPanel {
  /** @type {HudPanel|null} Currently visible instance (singleton) */
  static current = null;

  /**
   * @param {Token}         token       — canvas Token object
   * @param {HTMLElement}   anchorEl    — the HUD button element (for positioning)
   */
  constructor(token, anchorEl) {
    this.token     = token;
    this.tokenDoc  = token.document;
    this.anchorEl  = anchorEl;
    this.el        = null;  // root DOM element, set in render()
    this._onOutsideClick = this._onOutsideClick.bind(this);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Build and attach the panel to the DOM.
   * @returns {Promise<void>}
   */
  async render() {
    // Destroy any open panel
    HudPanel.current?.destroy();
    HudPanel.current = this;

    const data = await buildGridData(this.tokenDoc);
    if (!data) {
      ui.notifications.warn(game.i18n.localize('TOKEN_SLURP.notifications.noImages'));
      HudPanel.current = null;
      return;
    }

    const cols       = getSetting(SETTINGS.UI1_COLS);
    const rows       = getSetting(SETTINGS.UI1_ROWS);
    const cellWidth  = getSetting(SETTINGS.UI1_CELL_WIDTH);
    const cellHeight = getSetting(SETTINGS.UI1_CELL_HEIGHT);

    const panel = document.createElement('div');
    panel.id        = `${MODULE_ID}-hud-panel`;
    panel.className = 'token-slurp-hud-panel';

    const grid = document.createElement('div');
    grid.className = 'ts-grid-container';
    grid.style.maxHeight = `${rows * cellHeight + 12}px`;
    grid.style.width     = `${cols * cellWidth  + 12}px`;
    panel.appendChild(grid);

    renderImageGrid({
      container:  grid,
      files:      data.files,
      displayMap: data.displayMap,
      currentSrc: data.currentSrc,
      cellWidth,
      cellHeight,
      cols,
      onSelect:   async (filePath) => {
        await switchTokenImage(this.tokenDoc, filePath);
        this.destroy();
      },
    });

    document.body.appendChild(panel);
    this.el = panel;
    this._positionPanel();

    setTimeout(() => {
      document.addEventListener('click', this._onOutsideClick, { capture: true, passive: true });
    }, 0);
  }

  destroy() {
    this.el?.remove();
    this.el = null;
    document.removeEventListener('click', this._onOutsideClick, { capture: true });
    if (HudPanel.current === this) HudPanel.current = null;
  }

  _positionPanel() {
    if (!this.el || !this.anchorEl) return;
    const anchor = this.anchorEl.getBoundingClientRect();
    this.el.style.position = 'fixed';
    this.el.style.top      = `${anchor.top}px`;
    this.el.style.left     = `${anchor.right + 4}px`;
    const panelRect = this.el.getBoundingClientRect();
    if (panelRect.right > window.innerWidth) {
      this.el.style.left = `${window.innerWidth - panelRect.width - 8}px`;
    }
  }

  _onOutsideClick(ev) {
    if (!this.el) return;
    if (this.el.contains(ev.target) || this.anchorEl?.contains(ev.target)) return;
    this.destroy();
  }
}
