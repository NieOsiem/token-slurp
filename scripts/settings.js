import { MODULE_ID } from './constants.js';

export const SETTINGS = {
  THUMB_STORAGE_PATH: 'thumbStoragePath',
  // UI1 - token hud
  UI1_COLS:        'ui1Cols',
  UI1_ROWS:        'ui1Rows',
  UI1_CELL_WIDTH:  'ui1CellWidth',
  UI1_CELL_HEIGHT: 'ui1CellHeight',
  // UI2 — resizeable app
  UI2_CELL_WIDTH:   'ui2CellWidth',
  UI2_CELL_HEIGHT:  'ui2CellHeight',
  UI2_DEFAULT_COLS: 'ui2DefaultCols',
  UI2_DEFAULT_ROWS: 'ui2DefaultRows',
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

  // UI1 — quick HUD picker
  clientNum(SETTINGS.UI1_COLS,        'TOKEN_SLURP.settings.ui1Cols.name',        'TOKEN_SLURP.settings.ui1Cols.hint',         8,   1,  20);
  clientNum(SETTINGS.UI1_ROWS,        'TOKEN_SLURP.settings.ui1Rows.name',        'TOKEN_SLURP.settings.ui1Rows.hint',         7,   1,  20);
  clientNum(SETTINGS.UI1_CELL_WIDTH,  'TOKEN_SLURP.settings.ui1CellWidth.name',   'TOKEN_SLURP.settings.ui1CellWidth.hint',   80,  50, 512);
  clientNum(SETTINGS.UI1_CELL_HEIGHT, 'TOKEN_SLURP.settings.ui1CellHeight.name',  'TOKEN_SLURP.settings.ui1CellHeight.hint',  80,  50, 512);

  // UI2 — resizeable window
  clientNum(SETTINGS.UI2_CELL_WIDTH,   'TOKEN_SLURP.settings.ui2CellWidth.name',   'TOKEN_SLURP.settings.ui2CellWidth.hint',  140,  50, 512);
  clientNum(SETTINGS.UI2_CELL_HEIGHT,  'TOKEN_SLURP.settings.ui2CellHeight.name',  'TOKEN_SLURP.settings.ui2CellHeight.hint', 180,  50, 512);
  clientNum(SETTINGS.UI2_DEFAULT_COLS, 'TOKEN_SLURP.settings.ui2DefaultCols.name', 'TOKEN_SLURP.settings.ui2DefaultCols.hint',  5,   1,  20);
  clientNum(SETTINGS.UI2_DEFAULT_ROWS, 'TOKEN_SLURP.settings.ui2DefaultRows.name', 'TOKEN_SLURP.settings.ui2DefaultRows.hint',  3,   1,  20);
}

export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}