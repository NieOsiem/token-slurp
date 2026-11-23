import { MODULE_ID, ANIMATION_OPTIONS, FLAGS } from './constants.js';
import { getSetting, setSetting, SETTINGS } from './settings.js';
import { getTokenFiles, switchTokenImage, renderImageGrid, computeGroups, balancedCols } from './grid.js';
import { resolveDisplayUrlsProgressive, shouldUseThumb, isVideo, parseFilenameMetadata } from './wildcard.js';
import { getFavorites, toggleFavorite, pruneFavorites } from './favorites.js';

let _SlurpWindowClass = null;

function buildFavMedia(url) {
  if (!url) {
    const loading = document.createElement('span');
    loading.className = 'ts-fav-loading';
    return loading;
  }

  // Thumbnails are webp stills even for video sources; originals are not.
  if (isVideo(url)) {
    const vid = document.createElement('video');
    vid.src = url;
    vid.muted = true;
    vid.preload = 'metadata';
    vid.playsInline = true;
    vid.addEventListener('loadedmetadata', () => {
      try { vid.currentTime = Math.min(0.1, (vid.duration || 1) * 0.1); } catch { /* seeking may fail */ }
    }, { once: true });
    return vid;
  }

  const img = document.createElement('img');
  img.src = url;
  img.loading = 'lazy';
  img.draggable = false;
  return img;
}

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
      this._favScope           = null;
      this._favoritePaths      = new Set();
      this._favElements        = new Map();
      this._favPinned          = false;
      this._favOpenTimer       = null;
      this._favCloseTimer      = null;
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
        this._files = [];
        this._favScope = null;
        this._favoritePaths = new Set();
        this._renderFavorites();
        return;
      }

      this._syncTitle();

      const container = el.querySelector('.ts-grid-container');
      if (!container) return;

      this._setGridContent(`<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.window.loading')}</p>`);

      const tokenData = await getTokenFiles(this.tokenDoc);

      if (!tokenData) {
        this._setGridContent(`<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.notifications.noImages')}</p>`);
        this._files = [];
        this._favScope = null;
        this._favoritePaths = new Set();
        this._renderFavorites();
        return;
      }

      const { files, currentSrc, thumbMode } = tokenData;
      this._files      = files;
      this._displayMap = new Map();

      this._favScope = this.tokenDoc.flags?.[MODULE_ID]?.[FLAGS.WILDCARD_PATH] ?? null;
      const fileSet = new Set(files);
      const storedFavorites = this._favScope ? getFavorites(this._favScope) : [];
      const visibleFavorites = storedFavorites.filter(p => fileSet.has(p));

      if (storedFavorites.length !== visibleFavorites.length) {
        try {
          await pruneFavorites(this._favScope, fileSet);
        } catch (err) {
          console.warn(`[${MODULE_ID}] Could not prune stale favourites:`, err);
        }
      }

      this._favoritePaths = new Set(visibleFavorites);

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
        favoritePaths:    this._favoritePaths,
        onToggleFavorite: (filePath) => this._toggleFavorite(filePath),
        onSelect: (filePath) => this._selectFile(filePath),
      };

      if (!shouldUseThumb(files.length, thumbMode)) {
        this._displayMap = new Map(files.map(f => [f, f]));
        const { groupElements } = renderImageGrid({ ...sharedGridOpts, displayMap: this._displayMap });
        this._groupElements = groupElements;
      } else {
        const { updateCellDisplay, groupElements } = renderImageGrid({ ...sharedGridOpts, displayMap: new Map() });
        this._groupElements = groupElements;

        resolveDisplayUrlsProgressive(files, thumbMode, (filePath, url) => {
          if (this._gridGeneration !== generation) return;
          this._displayMap.set(filePath, url);
          updateCellDisplay(filePath, url);
          this._updateFavoriteThumb(filePath, url);
        });
      }

      this._renderFavorites();
      if (hasGroups) this._autoCollapseGroups(currentSrc);
      requestAnimationFrame(() => this._reapplyGroupLayout());
    }

    _setGridContent(html) {
      const container = this.element?.querySelector('.ts-grid-container');
      if (container) container.innerHTML = html;
    }

    async _selectFile(filePath) {
      if (!this._isTokenValid()) {
        ui.notifications.warn(game.i18n.localize('TOKEN_SLURP.notifications.tokenDeleted'));
        return;
      }
      this._syncActiveCell(filePath);
      await switchTokenImage(this.tokenDoc, filePath, this._animation, this._duration);
      if (!this._pinned) this.close();
    }

    // ── Favourites ────────────────────────────────────────────────────────────

    async _toggleFavorite(filePath) {
      if (!this._favScope) return;

      const result = await toggleFavorite(this._favScope, filePath);
      if (result.limitReached) {
        ui.notifications.warn(game.i18n.localize('TOKEN_SLURP.notifications.favoriteLimit'));
        return;
      }

      const fileSet = new Set(this._files);
      this._favoritePaths = new Set(result.favorites.filter(p => fileSet.has(p)));
      this._syncFavoriteCells();
      this._renderFavorites();
    }

    _syncFavoriteCells() {
      const el = this.element;
      if (!el) return;

      for (const cell of el.querySelectorAll('.ts-cell[data-src]')) {
        const isFav = this._favoritePaths.has(cell.dataset.src);
        cell.classList.toggle('ts-cell--fav', isFav);

        const btn = cell.querySelector('.ts-fav-toggle');
        if (!btn) continue;
        btn.setAttribute('aria-pressed', String(isFav));
        btn.title = game.i18n.localize(
          isFav ? 'TOKEN_SLURP.window.favoriteUnpin' : 'TOKEN_SLURP.window.favoritePin'
        );
      }
    }

    _renderFavorites() {
      const grid = this._favGrid;
      if (!grid) return;

      grid.replaceChildren();
      this._favElements = new Map();

      for (const filePath of this._favoritePaths) {
        const slot = document.createElement('div');
        slot.className = 'ts-fav-slot';

        const pick = document.createElement('button');
        pick.type      = 'button';
        pick.className = 'ts-fav-pick';
        pick.title     = filePath.split('/').pop();
        pick.append(buildFavMedia(this._displayMap.get(filePath) ?? null));
        pick.addEventListener('click', async ev => {
          ev.stopPropagation();
          if (!this._favPinned) this._favPop.hidden = true;
          await this._selectFile(filePath);
        });

        slot.appendChild(pick);
        grid.appendChild(slot);
        this._favElements.set(filePath, pick);
      }

      const count = this._favoritePaths.size;
      const cols  = Math.min(Math.max(count, 1), 5);
      grid.style.gridTemplateColumns = `repeat(${cols}, 64px)`;
      if (this._favCount) this._favCount.textContent = String(count);
      if (this._favEmpty) this._favEmpty.hidden = count > 0;
    }

    _updateFavoriteThumb(filePath, url) {
      const pick = this._favElements.get(filePath);
      if (pick) pick.replaceChildren(buildFavMedia(url));
    }

    // ── Group layout (tiling + row balancing) ─────────────────────────────────

    /**
     * Expand only the group containing the token's current image. With the
     * selector gone this is the sole replacement for its default collapse mode.
     * No match leaves every group expanded, as before.
     */
    _autoCollapseGroups(currentSrc) {
      if (!this._groupElements.size) return;

      let targetKey = null;

      if (currentSrc) {
        const meta = parseFilenameMetadata(currentSrc);
        if (meta.group && this._groupElements.has(meta.group)) targetKey = meta.group;
      }

      if (!targetKey) {
        const tokenName = this.tokenDoc?.name?.toLowerCase() ?? '';
        const matched   = this._groups.find(
          g => g.key !== '__ungrouped__' && g.label.toLowerCase() === tokenName
        );
        if (matched) targetKey = matched.key;
      }

      if (!targetKey) {
        const ungrouped = this._groups.find(g => g.key === '__ungrouped__');
        if (ungrouped?.files.includes(currentSrc)) targetKey = ungrouped.key;
      }

      if (!targetKey) return;

      for (const [key, { el }] of this._groupElements) {
        el.classList.toggle('ts-group--collapsed', key !== targetKey);
      }
    }

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

      // Favourites: star button with hover/click popover of pinned thumbnails.
      const favWrap = document.createElement('span');
      favWrap.className = 'ts-fav-wrap';

      const favBtn = document.createElement('button');
      favBtn.type      = 'button';
      favBtn.className = 'ts-fav-btn';
      favBtn.title     = game.i18n.localize('TOKEN_SLURP.window.favorites');
      favBtn.innerHTML = '<i class="fas fa-star"></i><span class="ts-fav-count">0</span>';

      const favPop = document.createElement('div');
      favPop.className = 'ts-popover ts-fav-pop';
      favPop.hidden    = true;

      const favGrid = document.createElement('div');
      favGrid.className = 'ts-fav-grid';

      const favEmpty = document.createElement('div');
      favEmpty.className = 'ts-fav-empty';
      favEmpty.textContent = game.i18n.localize('TOKEN_SLURP.window.favoritesEmpty');
      favEmpty.hidden = true;

      favPop.append(favGrid, favEmpty);
      favWrap.append(favBtn, favPop);

      this._favPop    = favPop;
      this._favGrid   = favGrid;
      this._favCount  = favBtn.querySelector('.ts-fav-count');
      this._favEmpty  = favEmpty;
      this._favPinned = false;
      this._favElements = new Map();

      const FAV_OPEN_DELAY  = 180;
      const FAV_CLOSE_DELAY = 250;

      favWrap.addEventListener('mouseenter', () => {
        clearTimeout(this._favCloseTimer);
        clearTimeout(this._favOpenTimer);
        this._favOpenTimer = setTimeout(() => {
          if (!favPop.hidden) return;
          animMenu.hidden    = true;
          durationPop.hidden = true;
          favPop.hidden      = false;
        }, FAV_OPEN_DELAY);
      });

      favWrap.addEventListener('mouseleave', () => {
        clearTimeout(this._favOpenTimer);
        clearTimeout(this._favCloseTimer);
        this._favCloseTimer = setTimeout(() => {
          if (!this._favPinned) favPop.hidden = true;
        }, FAV_CLOSE_DELAY);
      });

      favBtn.addEventListener('click', () => {
        clearTimeout(this._favOpenTimer);
        clearTimeout(this._favCloseTimer);

        if (favPop.hidden) {
          this._closeHeaderPopovers();
          this._favPinned = true;
          favPop.hidden   = false;
        } else if (this._favPinned) {
          this._favPinned = false;
          favPop.hidden   = true;
        } else {
          // Hover-opened popover: clicking pins it open.
          this._favPinned = true;
        }
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

      controls.append(favWrap, followBtn, reloadBtn, durationWrap, animWrap);

      const _stopEvent = ev => { ev.stopPropagation(); ev.stopImmediatePropagation(); };
      for (const node of [slider, animBtn, durationBtn, reloadBtn, followBtn, animMenu, durationPop, favBtn, favPop, favGrid]) {
        for (const evName of ['pointerdown', 'mousedown', 'dragstart', 'selectstart', 'dblclick']) {
          node.addEventListener(evName, _stopEvent, { capture: true });
        }
        node.addEventListener('touchstart', _stopEvent, { passive: false, capture: true });
        node.style.webkitAppRegion = 'no-drag';
      }

      this._closeHeaderPopovers = () => {
        animMenu.hidden    = true;
        durationPop.hidden = true;
        favPop.hidden      = true;
        this._favPinned    = false;
        clearTimeout(this._favOpenTimer);
        clearTimeout(this._favCloseTimer);
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
        if (animMenu.hidden && durationPop.hidden && favPop.hidden) return;
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
      clearTimeout(this._favOpenTimer);
      clearTimeout(this._favCloseTimer);
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