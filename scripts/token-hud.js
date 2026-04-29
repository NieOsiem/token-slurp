import { MODULE_ID, FLAGS } from './constants.js';
import { HudPanel } from './ui-hud.js';
import { openSlurpWindow } from './ui-window.js';

export function registerTokenHudHooks() {
  Hooks.on('renderTokenHUD', _onRenderTokenHUD);
  Hooks.on('closeTokenHUD', () => HudPanel.current?.destroy());
}

// ── Render handler ────────────────────────────────────────────────────────────

/**
 * @param {TokenHUD}  hud
 * @param {jQuery}    html
 * @param {object}    _data
 */
function _onRenderTokenHUD(hud, html, _data) {
  const token    = hud.object;
  const tokenDoc = token?.document;
  if (!tokenDoc) return;

  // Only show buttons if the wildcard is active AND the user has ownership
  const flags  = tokenDoc.flags?.[MODULE_ID] ?? {};
  if (!flags[FLAGS.WILDCARD_ACTIVE]) return;
  if (!_hasOwnership(tokenDoc)) return;

  // Normalise to plain HTMLElement — v13 passes jQuery, v14 passes HTMLElement
  const root = html instanceof HTMLElement ? html : html[0];
  const col  = root.querySelector('.col.right');
  if (!col) return;

  // ── Button 1: inline HUD panel ────────────────────────────────────────────
  const btn1 = _makeButton({
    id:       `${MODULE_ID}-hud-btn1`,
    icon:     `modules/${MODULE_ID}/assets/icon-hud.webp`,
    fallback: 'fa-images',
    tooltip:  game.i18n.localize('TOKEN_SLURP.hud.openPanel'),
  });

  btn1.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const existing = HudPanel.current;
    if (existing?.token === token) {
      existing.destroy();
      return;
    }
    const panel = new HudPanel(token, btn1, root);
    await panel.render();
  });

  // ── Button 2: ApplicationV2 window ───────────────────────────────────────
  const btn2 = _makeButton({
    id:       `${MODULE_ID}-hud-btn2`,
    icon:     `modules/${MODULE_ID}/assets/icon-window.webp`,
    fallback: 'fa-th',
    tooltip:  game.i18n.localize('TOKEN_SLURP.hud.openWindow'),
  });

  btn2.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    await openSlurpWindow(token);
  });

  col.append(btn1, btn2);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a HUD-style control button.
 * Uses a <img> if the asset file exists (webp icon), otherwise falls back
 * to a Font Awesome <i> so the code is functional without the assets.
 *
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.icon      — path to the webp asset
 * @param {string} opts.fallback  — Font Awesome class suffix (e.g. 'fa-images')
 * @param {string} opts.tooltip
 * @returns {HTMLElement}
 */
function _makeButton({ id, icon, fallback, tooltip }) {
  const btn = document.createElement('div');
  btn.id          = id;
  btn.className   = 'control-icon token-slurp-hud-btn';
  btn.dataset.tooltip = tooltip;

  // Try the webp asset; if it 404s the onerror handler swaps in the FA icon
  const img = document.createElement('img');
  img.src    = icon;
  img.width  = 36;
  img.height = 36;
  img.onerror = () => {
    img.replaceWith(_faIcon(fallback));
  };
  btn.appendChild(img);

  return btn;
}

function _faIcon(cls) {
  const i = document.createElement('i');
  i.className = `fas ${cls}`;
  return i;
}

/**
 * Return true if the current user has at least OWNER permission on the actor tied to this token, or is a GM.
 * @param {TokenDocument} tokenDoc
 * @returns {boolean}
 */
function _hasOwnership(tokenDoc) {
  if (game.user.isGM) return true;
  const actor = tokenDoc.actor;
  if (!actor) return false;
  return actor.testUserPermission(game.user, 'OWNER');
}