import { MODULE_ID, ANIMATION_OPTIONS, FLAGS } from './constants.js';
import { getSetting, setSetting, SETTINGS } from './settings.js';
import { getTokenFiles, switchTokenImage, renderImageGrid, computeGroups } from './grid.js';
import { resolveDisplayUrlsProgressive, shouldUseThumb, parseFilenameMetadata } from './wildcard.js';

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
      this._activeGroupKey     = null;   // null = All
      this._displayMap         = new Map();
      this._pinned             = false;
      this._animation          = getSetting(SETTINGS.UI2_ANIMATION);
      this._duration           = getSetting(SETTINGS.UI2_DURATION);
      this._tokenUpdateHookId  = null;
      this._deleteHookId       = null;
      this._refreshTimeout     = null;
      this._gridGeneration     = 0;
      this._groupElements      = new Map();  // key → { el, cellsEl }
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
      this._activeGroupKey = null;

      const container = el.querySelector('.ts-grid-container');
      if (!container) return;

      this._setGridContent(`<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.window.loading')}</p>`);

      const tokenData = await getTokenFiles(this.tokenDoc);

      if (!tokenData) {
        this._setGridContent(`<p class="ts-empty">${game.i18n.localize('TOKEN_SLURP.notifications.noImages')}</p>`);
        this._updateGroupSelector([]);
        return;
      }

      const { files, currentSrc, thumbMode } = tokenData;
      this._files      = files;
      this._displayMap = new Map();

      const nameGroupEnabled  = getSetting(SETTINGS.UI2_GROUP_NAME_ENABLED);
      const nameGroupMinCount = getSetting(SETTINGS.UI2_GROUP_NAME_MIN_COUNT);
      const { groups, hasGroups } = computeGroups(files, { nameGroupEnabled, nameGroupMinCount });
      this._groups = groups;

      this._updateGroupSelector(hasGroups ? groups : []);

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

      if (hasGroups) this._autoSelectGroup(currentSrc);
    }

    _setGridContent(html) {
      const container = this.element?.querySelector('.ts-grid-container');
      if (container) container.innerHTML = html;
    }

    // ── Group management ──────────────────────────────────────────────────────

    /**
     * Populate the group selector <select> in the header.
     * Hides the selector entirely when there are no groups.
     * @param {Array} groups
     */
    _updateGroupSelector(groups) {
      const sel = this.element?.querySelector('.ts-group-select');
      if (!sel) return;

      const wrap = sel.closest('.ts-group-select-wrap');

      if (!groups.length) {
        if (wrap) wrap.style.display = 'none';
        return;
      }

      if (wrap) wrap.style.display = '';

      sel.innerHTML = `<option value="">${game.i18n.localize('TOKEN_SLURP.window.groupAll')}</option>`;
      for (const g of groups) {
        const opt   = document.createElement('option');
        opt.value   = g.key;
        opt.textContent = g.label;
        sel.appendChild(opt);
      }
      sel.value = '';
    }

    /**
     * Apply a group selection to the rendered grid.
     * Mode behaviour:
     *   collapse — selected group stays expanded, all others collapse
     *   top      — scroll selected group to the top of the container
     *   none     — only scroll, no collapsing
     * null key = "All" — expand everything.
     *
     * @param {string|null} groupKey
     */
    _selectGroup(groupKey) {
      this._activeGroupKey = groupKey;

      const collapseMode = getSetting(SETTINGS.UI2_GROUP_COLLAPSE_MODE);
      const container    = this.element?.querySelector('.ts-grid-container');
      if (!container) return;

      if (groupKey === null) {
        // All — expand everything
        for (const { el } of this._groupElements.values()) {
          el.classList.remove('ts-group--collapsed');
        }
        container.scrollTop = 0;
        return;
      }

      if (collapseMode === 'collapse') {
        for (const [key, { el }] of this._groupElements) {
          el.classList.toggle('ts-group--collapsed', key !== groupKey);
        }
      }

      // Scroll the selected group header into view after any layout changes settle
      requestAnimationFrame(() => {
        const targetEntry = this._groupElements.get(groupKey);
        if (!targetEntry) return;

        if (collapseMode === 'top' || collapseMode === 'none') {
          const containerTop = container.getBoundingClientRect().top;
          const headerTop    = targetEntry.el.getBoundingClientRect().top;
          container.scrollTop += headerTop - containerTop;
        } else {
          // collapse mode — group is the only visible one, scroll to top
          container.scrollTop = 0;
        }
      });
    }

    /**
     * Attempt to auto-select a group on open, based on:
     *   1. _group_ tag of the current active image (explicit always wins)
     *   2. token canvas name matched against group labels (case-insensitive)
     * Falls back to All if no match.
     *
     * @param {string} currentSrc
     */
    _autoSelectGroup(currentSrc) {
      if (!this._groups.length) return;

      let targetKey = null;

      // 1. Explicit group tag on the active image
      if (currentSrc) {
        const meta = parseFilenameMetadata(currentSrc);
        if (meta.group) {
          const found = this._groups.find(g => g.key === meta.group);
          if (found) targetKey = found.key;
        }
      }

      // 2. Token canvas name fallback
      if (!targetKey) {
        const tokenName = this.tokenDoc?.name?.toLowerCase() ?? '';
        const matched   = this._groups.find(
          g => g.key !== '__ungrouped__' && g.label.toLowerCase() === tokenName
        );
        if (matched) targetKey = matched.key;
      }
      // 3. Active image is in the Ungrouped bucket
      if (!targetKey) {
        const ungrouped = this._groups.find(g => g.key === '__ungrouped__');
        if (ungrouped?.files.includes(currentSrc)) targetKey = '__ungrouped__';
      }

      // Sync the selector UI
      const sel = this.element?.querySelector('.ts-group-select');
      if (sel) sel.value = targetKey;

      this._selectGroup(targetKey);
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

      // ── Pin toggle (prepended to header) ─────────────────────────────────
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

      // ── Right-hand control strip ──────────────────────────────────────────
      const controls     = document.createElement('div');
      controls.className = 'ts-header-controls';

      // Group selector
      const groupWrap     = document.createElement('span');
      groupWrap.className = 'ts-group-select-wrap';
      groupWrap.style.display = 'none';   // hidden until groups exist

      const groupSel     = document.createElement('select');
      groupSel.className = 'ts-group-select';
      groupSel.title     = game.i18n.localize('TOKEN_SLURP.window.groupSelect');
      groupWrap.appendChild(groupSel);

      groupSel.addEventListener('change', () => {
        const key = groupSel.value || null;
        this._selectGroup(key);
      });

      // Reload button
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

      // Follow button
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

      // Duration slider + label
      const slider     = document.createElement('input');
      slider.type      = 'range';
      slider.className = 'ts-duration-slider';
      slider.min       = '100';
      slider.max       = '3000';
      slider.step      = '100';
      slider.value     = String(this._duration);
      slider.title     = game.i18n.localize('TOKEN_SLURP.window.duration');

      const durationLabel     = document.createElement('span');
      durationLabel.className = 'ts-duration-label';
      durationLabel.textContent = `${this._duration}ms`;

      // Animation select
      const animSel     = document.createElement('select');
      animSel.className = 'ts-anim-select';
      animSel.title     = game.i18n.localize('TOKEN_SLURP.window.animation');
      animSel.innerHTML = ANIMATION_OPTIONS.map(o =>
        `<option value="${o.value}"${o.value === this._animation ? ' selected' : ''}>${game.i18n.localize(o.label)}</option>`
      ).join('');

      const sep     = document.createElement('span');
      sep.className = 'ts-controls-sep';

      controls.append(groupWrap, sep, followBtn, reloadBtn, slider, durationLabel, animSel);

      // Prevent Foundry's drag/window-move handlers from swallowing control interactions
      const _stopEvent = ev => { ev.stopPropagation(); ev.stopImmediatePropagation(); };
      for (const node of [slider, animSel, reloadBtn, followBtn, groupSel]) {
        for (const evName of ['pointerdown', 'mousedown', 'dragstart', 'selectstart']) {
          node.addEventListener(evName, _stopEvent, { capture: true });
        }
        node.addEventListener('touchstart', _stopEvent, { passive: false, capture: true });
        node.style.webkitAppRegion = 'no-drag';
      }

      const syncSliderVisibility = (value) => {
        const instant = value === 'none';
        slider.style.display       = instant ? 'none' : '';
        durationLabel.style.display = instant ? 'none' : '';
      };
      syncSliderVisibility(this._animation);

      animSel.addEventListener('change', ev => {
        this._animation = ev.currentTarget.value;
        setSetting(SETTINGS.UI2_ANIMATION, this._animation);
        syncSliderVisibility(this._animation);
      });

      slider.addEventListener('input', ev => {
        this._duration = Number(ev.currentTarget.value);
        setSetting(SETTINGS.UI2_DURATION, this._duration);
        durationLabel.textContent = `${this._duration}ms`;
      });

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