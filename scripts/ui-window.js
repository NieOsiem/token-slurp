import { MODULE_ID, ANIMATION_OPTIONS, FLAGS } from './constants.js';
import { getSetting, setSetting, SETTINGS } from './settings.js';
import { getTokenFiles, switchTokenImage, renderImageGrid, computeGroups, balancedCols } from './grid.js';
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
      this._groups             = [];
      this._displayMap         = new Map();
      this._pinned             = false;
      this._animation          = getSetting(SETTINGS.UI2_ANIMATION);
      this._duration           = getSetting(SETTINGS.UI2_DURATION);
      this._tokenUpdateHookId  = null;
      this._deleteHookId       = null;
      this._refreshTimeout     = null;
      this._gridGeneration     = 0;
      this._groupElements      = new Map();
      this._resizeObserver     = null;
      this._layoutTimeout      = null;
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
      this._registerResizeObserver();
      this._registerGroupSyncHandler();
    }

    // ── Grid management ───────────────────────────────────────────────────────

    _isTokenValid() {
      return !!this.tokenDoc?.parent?.tokens?.has(this.tokenDoc.id);
    }

    async _refreshGrid(newTokenDoc = null) {
      const el = this.element;
      if (!el) return;

      if (newTokenDoc && newTokenDoc !== this.tokenDoc) {
        _SlurpWindowClass._instances.delete(this.tokenDoc.id);
        this.tokenDoc = newTokenDoc;
        this.token    = canvas.tokens?.placeables.find(t => t.document === newTokenDoc) ?? this.token;
        _SlurpWindowClass._instances.set(this.tokenDoc.id, this);
      } else if (!newTokenDoc && !this._isTokenValid()) {
        this._gridGeneration++;
        this._setGridContent(`<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.notifications.tokenDeleted')}</p>`);
        return;
      }

      this._syncTitle();

      const container = el.querySelector('.ts-grid-container');
      if (!container) return;

      this._setGridContent(`<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.window.loading')}</p>`);

      const tokenData = await getTokenFiles(this.tokenDoc);

      if (!tokenData) {
        this._setGridContent(`<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.notifications.noImages')}</p>`);
        return;
      }

      const { files, currentSrc, thumbMode } = tokenData;
      this._files      = files;
      this._displayMap = new Map();

      const nameGroupEnabled  = getSetting(SETTINGS.UI2_GROUP_NAME_ENABLED);
      const nameGroupMinCount = getSetting(SETTINGS.UI2_GROUP_NAME_MIN_COUNT);
      const { groups, hasGroups } = computeGroups(files, { nameGroupEnabled, nameGroupMinCount });
      this._groups = groups;

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
        groups:      hasGroups ? groups : undefined,
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
        const { groupElements } = renderImageGrid({ ...sharedGridOpts, displayMap: new Map(files.map(f => [f, f])) });
        this._groupElements = groupElements;
      } else {
        const { updateCellDisplay, groupElements } = renderImageGrid({ ...sharedGridOpts, displayMap: new Map() });
        this._groupElements = groupElements;

        resolveDisplayUrlsProgressive(files, thumbMode, (filePath, url) => {
          if (this._gridGeneration !== generation) return;
          this._displayMap.set(filePath, url);
          updateCellDisplay(filePath, url);
        });
      }

      requestAnimationFrame(() => this._reapplyGroupLayout());
    }

    _setGridContent(html) {
      const container = this.element?.querySelector('.ts-grid-container');
      if (container) container.innerHTML = html;
    }

    // ── Group layout (tiling + row balancing) ─────────────────────────────────

    _registerResizeObserver() {
      if (this._resizeObserver) return;
      const container = this.element?.querySelector('.ts-grid-container');
      if (!container) return;
      this._resizeObserver = new ResizeObserver(() => {
        clearTimeout(this._layoutTimeout);
        this._layoutTimeout = setTimeout(() => this._reapplyGroupLayout(), 50);
      });
      this._resizeObserver.observe(container);
    }

    /**
     * In tiling mode, collapsing or expanding one group in a row should sync all
     * groups on that same row. Bound once via a dataset flag; always reads the
     * live _groupElements map so it stays correct across grid refreshes.
     */
    _registerGroupSyncHandler() {
      const container = this.element?.querySelector('.ts-grid-container');
      if (!container || container.dataset.tsSyncBound) return;
      container.dataset.tsSyncBound = '1';

      container.addEventListener('click', (ev) => {
        if (parseInt(getSetting(SETTINGS.UI2_GROUP_LAYOUT_COLS)) <= 1) return;
        if (!ev.target.closest('.ts-group-header')) return;
        const clickedGroup = ev.target.closest('.ts-group');
        if (!clickedGroup) return;

        const isCollapsed = clickedGroup.classList.contains('ts-group--collapsed');
        const clickedTop  = clickedGroup.getBoundingClientRect().top;

        for (const { el } of this._groupElements.values()) {
          if (el === clickedGroup) continue;
          if (Math.abs(el.getBoundingClientRect().top - clickedTop) < 3) {
            el.classList.toggle('ts-group--collapsed', isCollapsed);
          }
        }
      });
    }

    /**
     * Apply tiling and/or row-balancing to the current group elements.
     * Safe to call repeatedly; reads settings fresh each time.
     *
     * Tiling:    the grouped container switches to a CSS grid of N equal columns.
     *            Groups that would exceed FULLSPAN_ROWS rows in a single column
     *            get grid-column: 1/-1 so they span the full width.
     * Balancing: groups with a sparse last row get a slightly higher column count
     *            (and proportionally narrower cells) to spread images more evenly.
     *            Cell width is never reduced below 70 % of the configured size.
     */
    _reapplyGroupLayout() {
      const container = this.element?.querySelector('.ts-grid-container');
      if (!container) return;

      if (!this._groupElements.size) {
        container.classList.remove('ts-layout-grid');
        container.style.removeProperty('--ts-layout-cols');
        return;
      }

      const layoutCols     = parseInt(getSetting(SETTINGS.UI2_GROUP_LAYOUT_COLS)) || 1;
      const balanceEnabled = getSetting(SETTINGS.UI2_GROUP_BALANCE_ROWS);
      const useGrid        = layoutCols > 1;

      container.classList.toggle('ts-layout-grid', useGrid);
      if (useGrid) {
        container.style.setProperty('--ts-layout-cols', String(layoutCols));
      } else {
        container.style.removeProperty('--ts-layout-cols');
      }

      if (!useGrid && !balanceEnabled) return;

      const cellWidth      = getSetting(SETTINGS.UI2_CELL_WIDTH);
      const gap            = 4;   // gap between image cells
      const COL_GAP        = 6;   // gap between layout columns (matches CSS)
      const GROUP_SIDE_PAD = 4;   // 2px left + 2px right CSS padding on .ts-group
      const innerWidth     = container.clientWidth - 4; // subtract container's 2px side padding
      if (innerWidth <= 0) return;

      // Width of a single layout column; equals innerWidth when not in grid mode.
      const colWidth        = useGrid ? (innerWidth - (layoutCols - 1) * COL_GAP) / layoutCols : innerWidth;
      const colContentWidth = colWidth - GROUP_SIDE_PAD;
      const colCellCols     = Math.max(1, Math.floor((colContentWidth + gap) / (cellWidth + gap)));

      // Full-span groups use the entire container width.
      const fullContentWidth = innerWidth - GROUP_SIDE_PAD;
      const fullCellCols     = useGrid
        ? Math.max(1, Math.floor((fullContentWidth + gap) / (cellWidth + gap)))
        : colCellCols;

      // Groups exceeding this many rows in a single column span all columns instead.
      const FULLSPAN_ROWS = 3;

      for (const group of this._groups) {
        const entry = this._groupElements.get(group.key);
        if (!entry) continue;
        const { el, cellsEl } = entry;

        const isFullSpan = useGrid && Math.ceil(group.files.length / colCellCols) > FULLSPAN_ROWS;
        el.classList.toggle('ts-group--fullspan', isFullSpan);

        if (balanceEnabled) {
          const groupCellCols = isFullSpan ? fullCellCols    : colCellCols;
          const availWidth    = isFullSpan ? fullContentWidth : colContentWidth;
          const bCols = balancedCols(group.files.length, groupCellCols);
          if (bCols) {
            const bCellWidth = Math.floor((availWidth - (bCols - 1) * gap) / bCols);
            if (bCellWidth >= Math.floor(cellWidth * 0.7)) {
              cellsEl.style.gridTemplateColumns = `repeat(${bCols}, minmax(${bCellWidth}px, 1fr))`;
              cellsEl.style.setProperty('--ts-cell-w', `${bCellWidth}px`);
            } else {
              cellsEl.style.gridTemplateColumns = '';
              cellsEl.style.removeProperty('--ts-cell-w');
            }
          } else {
            cellsEl.style.gridTemplateColumns = '';
            cellsEl.style.removeProperty('--ts-cell-w');
          }
        } else {
          cellsEl.style.gridTemplateColumns = '';
          cellsEl.style.removeProperty('--ts-cell-w');
        }
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
        this._setGridContent(`<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.notifications.tokenDeleted')}</p>`);
      });
    }

    _syncActiveCell(src) {
      const container = this.element?.querySelector('.ts-grid-container');
      if (!container) return;
      container.querySelectorAll('.ts-cell--active').forEach(c => c.classList.remove('ts-cell--active'));
      container.querySelector(`.ts-cell[data-src="${CSS.escape(src)}"]`)?.classList.add('ts-cell--active');
    }

    // ── Header controls ───────────────────────────────────────────────────────

    _injectHeaderControls(el) {
      const header = el.querySelector('.window-header');
      if (!header || header.querySelector('.ts-header-controls')) return;

      const pinBtn     = document.createElement('button');
      pinBtn.type      = 'button';
      pinBtn.className = `ts-pin-toggle${this._pinned ? ' ts-pinned' : ''}`;
      pinBtn.title     = game.i18n.localize('TOKEN_SLURP.window.pin');
      pinBtn.innerHTML = '<i class="fas fa-thumbtack"></i>';
      header.prepend(pinBtn);
      pinBtn.addEventListener('click', () => {
        this._pinned = !this._pinned;
        pinBtn.classList.toggle('ts-pinned', this._pinned);
      });

      const controls     = document.createElement('div');
      controls.className = 'ts-header-controls';

      const reloadBtn     = document.createElement('button');
      reloadBtn.type      = 'button';
      reloadBtn.className = 'ts-reload-btn';
      reloadBtn.title     = game.i18n.localize('TOKEN_SLURP.window.reloadSelected');
      reloadBtn.innerHTML = '<i class="fas fa-sync-alt"></i>';
      reloadBtn.addEventListener('click', async () => {
        const controlled = canvas.tokens?.controlled ?? [];
        const targetDoc  = controlled.length === 1 ? controlled[0].document : this.tokenDoc;

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

      const followBtn     = document.createElement('button');
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
          return td.actor?.id === myActorId &&
                 td.flags?.[MODULE_ID]?.[FLAGS.WILDCARD_PATH] === myPath;
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

      // Duration: compact readout that expands into the slider on click.
      const durationWrap = document.createElement('span');
      durationWrap.className = 'ts-duration-wrap';

      const durationBtn     = document.createElement('button');
      durationBtn.type      = 'button';
      durationBtn.className = 'ts-duration-btn';
      durationBtn.title     = game.i18n.localize('TOKEN_SLURP.window.duration');

      const slider     = document.createElement('input');
      slider.type      = 'range';
      slider.className = 'ts-duration-slider';
      slider.min       = '100';
      slider.max       = '3000';
      slider.step      = '100';
      slider.value     = String(this._duration);

      const durationPop     = document.createElement('div');
      durationPop.className = 'ts-popover ts-duration-pop';
      durationPop.hidden    = true;
      durationPop.appendChild(slider);

      durationWrap.append(durationBtn, durationPop);

      // Animation: button showing the current mode, expanding into the option list.
      const animWrap     = document.createElement('span');
      animWrap.className = 'ts-anim-wrap';

      const animBtn     = document.createElement('button');
      animBtn.type      = 'button';
      animBtn.className = 'ts-anim-btn';
      animBtn.title     = game.i18n.localize('TOKEN_SLURP.window.animation');
      animBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i><span class="ts-anim-label"></span>';

      const animMenu     = document.createElement('div');
      animMenu.className = 'ts-popover ts-anim-menu';
      animMenu.hidden    = true;

      for (const opt of ANIMATION_OPTIONS) {
        const item         = document.createElement('button');
        item.type          = 'button';
        item.className     = 'ts-anim-option';
        item.dataset.value = opt.value;
        item.textContent   = game.i18n.localize(opt.label);
        item.addEventListener('click', () => {
          this._animation = opt.value;
          setSetting(SETTINGS.UI2_ANIMATION, this._animation);
          this._syncAnimationUI();
          this._closeHeaderPopovers();
        });
        animMenu.appendChild(item);
      }

      animWrap.append(animBtn, animMenu);

      controls.append(followBtn, reloadBtn, durationWrap, animWrap);

      const _stopEvent = ev => { ev.stopPropagation(); ev.stopImmediatePropagation(); };
      for (const node of [slider, animBtn, durationBtn, reloadBtn, followBtn, animMenu, durationPop]) {
        for (const evName of ['pointerdown', 'mousedown', 'dragstart', 'selectstart']) {
          node.addEventListener(evName, _stopEvent, { capture: true });
        }
        node.addEventListener('touchstart', _stopEvent, { passive: false, capture: true });
        node.style.webkitAppRegion = 'no-drag';
      }

      this._closeHeaderPopovers = () => {
        animMenu.hidden    = true;
        durationPop.hidden = true;
      };

      this._syncAnimationUI = () => {
        const current = ANIMATION_OPTIONS.find(o => o.value === this._animation) ?? ANIMATION_OPTIONS[0];
        animBtn.querySelector('.ts-anim-label').textContent = game.i18n.localize(current.label);

        for (const item of animMenu.children) {
          item.classList.toggle('ts-anim-option--active', item.dataset.value === this._animation);
        }

        const instant = this._animation === 'none';
        durationWrap.style.display = instant ? 'none' : '';
        if (instant) durationPop.hidden = true;
        durationBtn.textContent = `${this._duration}ms`;
      };
      this._syncAnimationUI();

      animBtn.addEventListener('click', () => {
        const open = animMenu.hidden;
        this._closeHeaderPopovers();
        animMenu.hidden = !open;
      });

      durationBtn.addEventListener('click', () => {
        const open = durationPop.hidden;
        this._closeHeaderPopovers();
        durationPop.hidden = !open;
      });

      slider.addEventListener('input', ev => {
        this._duration = Number(ev.currentTarget.value);
        setSetting(SETTINGS.UI2_DURATION, this._duration);
        durationBtn.textContent = `${this._duration}ms`;
      });

      if (this._headerDocListener) {
        document.removeEventListener('pointerdown', this._headerDocListener, true);
      }
      if (this._headerEscListener) {
        document.removeEventListener('keydown', this._headerEscListener, true);
      }

      this._headerDocListener = ev => {
        if (!controls.contains(ev.target)) this._closeHeaderPopovers();
      };
      document.addEventListener('pointerdown', this._headerDocListener, true);

      this._headerEscListener = ev => {
        if (ev.key !== 'Escape') return;
        if (animMenu.hidden && durationPop.hidden) return;
        // Keep Foundry's global Escape handler from closing the window underneath.
        ev.preventDefault();
        ev.stopPropagation();
        this._closeHeaderPopovers();
      };
      document.addEventListener('keydown', this._headerEscListener, true);

      const firstFoundryBtn = header.querySelector('.header-control, [data-action="close"]');
      if (firstFoundryBtn) header.insertBefore(controls, firstFoundryBtn);
      else header.appendChild(controls);
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
      this._resizeObserver?.disconnect();
      this._resizeObserver = null;
      clearTimeout(this._layoutTimeout);

      if (this._headerDocListener) {
        document.removeEventListener('pointerdown', this._headerDocListener, true);
        this._headerDocListener = null;
      }
      if (this._headerEscListener) {
        document.removeEventListener('keydown', this._headerEscListener, true);
        this._headerEscListener = null;
      }
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