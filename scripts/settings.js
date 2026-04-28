import { MODULE_ID } from './constants.js';

export const SETTINGS = {
  THUMB_STORAGE_PATH: 'thumbStoragePath',
  THUMB_SIZE:         'thumbSize',
  // UI1 — quick HUD picker
  UI1_COLS:        'ui1Cols',
  UI1_ROWS:        'ui1Rows',
  UI1_CELL_WIDTH:  'ui1CellWidth',
  UI1_CELL_HEIGHT: 'ui1CellHeight',
  UI1_ZOOM:        'ui1Zoom',
  UI1_ZOOM_ORIGIN: 'ui1ZoomOrigin',
  // UI2 — resizeable app
  UI2_CELL_WIDTH:   'ui2CellWidth',
  UI2_CELL_HEIGHT:  'ui2CellHeight',
  UI2_DEFAULT_COLS: 'ui2DefaultCols',
  UI2_DEFAULT_ROWS: 'ui2DefaultRows',
  UI2_ZOOM:         'ui2Zoom',
  UI2_ZOOM_ORIGIN:  'ui2ZoomOrigin',
  UI2_ANIMATION: 'ui2Animation',
  UI2_DURATION:  'ui2Duration',
};

export function registerSettings() {
  // ── World settings (GM only) ─────────────────────────────────────────────

  game.settings.register(MODULE_ID, SETTINGS.THUMB_STORAGE_PATH, {
    name:    'TOKEN_SLURP.settings.thumbStoragePath.name',
    hint:    'TOKEN_SLURP.settings.thumbStoragePath.hint',
    scope:   'world',
    config:  true,
    type:    String,
    default: 'token-slurp/thumbs',
  });

  game.settings.register(MODULE_ID, SETTINGS.THUMB_SIZE, {
    name:    'TOKEN_SLURP.settings.thumbSize.name',
    hint:    'TOKEN_SLURP.settings.thumbSize.hint',
    scope:   'world',
    config:  true,
    type:    Number,
    default: 320,
    range:   { min: 256, max: 768, step: 64 },
  });

  // ── Client settings (per-user) ───────────────────────────────────────────

  /**
   * Register a numeric client setting.
   * @param {string} key
   * @param {string} name   — i18n key
   * @param {string} hint   — i18n key
   * @param {number} def    — default value
   * @param {number} min
   * @param {number} max
   * @param {number} [step=1]
   */
  const clientNum = (key, name, hint, def, min, max, step = 1) =>
    game.settings.register(MODULE_ID, key, {
      name, hint,
      scope:   'client',
      config:  true,
      type:    Number,
      default: def,
      range:   { min, max, step },
    });

  const clientZoomOrigin = (key, name, hint) =>
    game.settings.register(MODULE_ID, key, {
      name, hint,
      scope:   'client',
      config:  true,
      type:    String,
      default: 'center center',
      choices: {
        'center center': 'TOKEN_SLURP.settings.zoomOrigin.center',
        'center top':    'TOKEN_SLURP.settings.zoomOrigin.top',
        'center bottom': 'TOKEN_SLURP.settings.zoomOrigin.bottom',
        'left center':   'TOKEN_SLURP.settings.zoomOrigin.left',
        'right center':  'TOKEN_SLURP.settings.zoomOrigin.right',
        'left top':      'TOKEN_SLURP.settings.zoomOrigin.topLeft',
        'right top':     'TOKEN_SLURP.settings.zoomOrigin.topRight',
        'left bottom':   'TOKEN_SLURP.settings.zoomOrigin.bottomLeft',
        'right bottom':  'TOKEN_SLURP.settings.zoomOrigin.bottomRight',
      },
    });

  // UI1 — quick HUD picker
  clientNum(SETTINGS.UI1_COLS,        'TOKEN_SLURP.settings.ui1Cols.name',        'TOKEN_SLURP.settings.ui1Cols.hint',         8,   1,  20);
  clientNum(SETTINGS.UI1_ROWS,        'TOKEN_SLURP.settings.ui1Rows.name',        'TOKEN_SLURP.settings.ui1Rows.hint',         7,   1,  20);
  clientNum(SETTINGS.UI1_CELL_WIDTH,  'TOKEN_SLURP.settings.ui1CellWidth.name',   'TOKEN_SLURP.settings.ui1CellWidth.hint',   80,  50, 512);
  clientNum(SETTINGS.UI1_CELL_HEIGHT, 'TOKEN_SLURP.settings.ui1CellHeight.name',  'TOKEN_SLURP.settings.ui1CellHeight.hint',  80,  50, 512);
  clientNum(SETTINGS.UI1_ZOOM,        'TOKEN_SLURP.settings.ui1Zoom.name',        'TOKEN_SLURP.settings.ui1Zoom.hint',        1.0, 1.0, 2.0, 0.1);
  clientZoomOrigin(SETTINGS.UI1_ZOOM_ORIGIN, 'TOKEN_SLURP.settings.ui1ZoomOrigin.name', 'TOKEN_SLURP.settings.ui1ZoomOrigin.hint');

  // UI2 — resizeable window
  clientNum(SETTINGS.UI2_CELL_WIDTH,   'TOKEN_SLURP.settings.ui2CellWidth.name',   'TOKEN_SLURP.settings.ui2CellWidth.hint',  140,  50, 512);
  clientNum(SETTINGS.UI2_CELL_HEIGHT,  'TOKEN_SLURP.settings.ui2CellHeight.name',  'TOKEN_SLURP.settings.ui2CellHeight.hint', 180,  50, 512);
  clientNum(SETTINGS.UI2_DEFAULT_COLS, 'TOKEN_SLURP.settings.ui2DefaultCols.name', 'TOKEN_SLURP.settings.ui2DefaultCols.hint',  5,   1,  20);
  clientNum(SETTINGS.UI2_DEFAULT_ROWS, 'TOKEN_SLURP.settings.ui2DefaultRows.name', 'TOKEN_SLURP.settings.ui2DefaultRows.hint',  3,   1,  20);
  clientNum(SETTINGS.UI2_ZOOM,         'TOKEN_SLURP.settings.ui2Zoom.name',        'TOKEN_SLURP.settings.ui2Zoom.hint',        1.0, 1.0, 2.0, 0.1);
  clientZoomOrigin(SETTINGS.UI2_ZOOM_ORIGIN, 'TOKEN_SLURP.settings.ui2ZoomOrigin.name', 'TOKEN_SLURP.settings.ui2ZoomOrigin.hint');

  // ── Hidden persisted state — not shown in settings UI ────────────────────
  game.settings.register(MODULE_ID, SETTINGS.UI2_ANIMATION, {
    scope: 'client', config: false, type: String, default: 'none',
  });
  game.settings.register(MODULE_ID, SETTINGS.UI2_DURATION, {
    scope: 'client', config: false, type: Number, default: 800,
  });
}

export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}
