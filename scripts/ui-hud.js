import { MODULE_ID } from './constants.js';
import { getSetting, SETTINGS } from './settings.js';
import { getTokenFiles, switchTokenImage, renderImageGrid } from './grid.js';
import { resolveDisplayUrlsProgressive, shouldUseThumb } from './wildcard.js';

//UI1 — lightweight panel on token hud.
export class HudPanel {
  /** @type {HudPanel|null} Currently visible instance (singleton) */
  static current = null;

  /**
   * @param {Token}         token       — canvas Token object
   * @param {HTMLElement}   anchorEl    — the HUD button element (used for outside-click detection)
   * @param {HTMLElement}   hudRoot     — the TokenHUD root element; panel is appended
   *                                      here so it moves with the canvas automatically
   */
  constructor(token, anchorEl, hudRoot) {
    this.token     = token;
    this.tokenDoc  = token.document;
    this.anchorEl  = anchorEl;
    this.hudRoot   = hudRoot;
    this.el        = null;  // root DOM element, set in render()
    this._onOutsideClick = this._onOutsideClick.bind(this);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Build and attach the panel to the HUD root element.
   * Opens instantly with placeholder cells, then fills in display URLs
   * progressively as they become available.
   * @returns {Promise<void>}
   */
  async render() {
    HudPanel.current?.destroy();
    HudPanel.current = this;

    // ── Phase 1: fast — resolve file list (cached after first open) ──────────
    const tokenData = await getTokenFiles(this.tokenDoc);
    if (!tokenData) {
      ui.notifications.warn(game.i18n.localize('TOKEN_SLURP.notifications.noImages'));
      HudPanel.current = null;
      return;
    }

    const { files, currentSrc, thumbMode } = tokenData;

    const cols       = getSetting(SETTINGS.UI1_COLS);
    const rows       = getSetting(SETTINGS.UI1_ROWS);
    const cellWidth  = getSetting(SETTINGS.UI1_CELL_WIDTH);
    const cellHeight = getSetting(SETTINGS.UI1_CELL_HEIGHT);
    const zoom       = getSetting(SETTINGS.UI1_ZOOM);
    const zoomOrigin = getSetting(SETTINGS.UI1_ZOOM_ORIGIN);

    const panel = document.createElement('div');
    panel.id        = `${MODULE_ID}-hud-panel`;
    panel.className = 'token-slurp-hud-panel';

    const grid = document.createElement('div');
    grid.className = 'ts-grid-container';
    grid.style.maxHeight = `${rows * cellHeight + 12}px`;
    grid.style.width = `${cols * cellWidth + 12 + 16}px`;
    panel.appendChild(grid);

    const sharedGridOpts = {
      container:  grid,
      files,
      currentSrc,
      cellWidth,
      cellHeight,
      cols,
      zoom,
      zoomOrigin,
      onSelect:   async (filePath) => {
        await switchTokenImage(this.tokenDoc, filePath);
        this.destroy();
      },
    };

    if (!shouldUseThumb(files.length, thumbMode)) {
      // ── Lazy mode ────────────────────────────────────────────────────────────
      // Pass the complete map so renderImageGrid activates its IntersectionObserver
      // path (defers <img> creation until cells scroll into view).
      renderImageGrid({ ...sharedGridOpts, displayMap: new Map(files.map(f => [f, f])) });
    } else {
      // ── Thumb mode ───────────────────────────────────────────────────────────
      // Render placeholder cells instantly, fill in display URLs progressively.
      // Fire-and-forget; updateCellDisplay guards against detached cells via isConnected.
      const { updateCellDisplay } = renderImageGrid({ ...sharedGridOpts, displayMap: new Map() });
      resolveDisplayUrlsProgressive(files, thumbMode, (filePath, url) => {
        updateCellDisplay(filePath, url);
      });
    }

    this.hudRoot.appendChild(panel);
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
    if (!this.el || !this.hudRoot) return;

    const col = this.hudRoot.querySelector('.col.right');
    if (!col) return;

    let left = 0;
    let top  = 0;
    let node = col;
    while (node && node !== this.hudRoot) {
      left += node.offsetLeft;
      top  += node.offsetTop;
      node  = node.offsetParent;
    }

    this.el.style.top  = `${top}px`;
    this.el.style.left = `${left + col.offsetWidth + 4}px`;
  }

  _onOutsideClick(ev) {
    if (!this.el) return;
    if (this.el.contains(ev.target) || this.anchorEl?.contains(ev.target)) return;
    this.destroy();
  }
}