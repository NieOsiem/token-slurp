import { MODULE_ID, FLAGS, THUMB_MODES } from './constants.js';

export function registerTokenConfigHooks() {
  Hooks.on('renderTokenConfig', _onRenderTokenConfig);
  Hooks.on('renderPrototypeTokenConfig', _onRenderTokenConfig);
}

// In Foundry v13 the hook receives (app, jQuery, data).
// In Foundry v14 TokenConfig is ApplicationV2 and receives (app, HTMLElement, data).
async function _onRenderTokenConfig(app, html, _data) {
  const token = app.document ?? app.token ?? app.object;
  if (!token) return;

  const flags     = token.flags?.[MODULE_ID] ?? {};
  const path      = flags[FLAGS.WILDCARD_PATH]  ?? '';
  const active    = flags[FLAGS.WILDCARD_ACTIVE] ?? false;
  const thumbMode = flags[FLAGS.THUMB_MODE]      ?? THUMB_MODES.AUTO;

  const content = await renderTemplate(
    `modules/${MODULE_ID}/templates/token-config.hbs`,
    {
      wildcardPath:   path,
      wildcardActive: active,
      thumbModeAuto:  thumbMode === THUMB_MODES.AUTO,
      thumbModeForce: thumbMode === THUMB_MODES.FORCE,
      thumbModeLazy:  thumbMode === THUMB_MODES.LAZY,
    }
  );

  // Normalise to a plain HTMLElement
  const root     = html instanceof HTMLElement ? html : html[0];
  const fragment = document.createRange().createContextualFragment(content);

  const browseBtn = fragment.querySelector(`.${MODULE_ID}-browse`);
  const pathInput = fragment.querySelector(`[name="flags.token-slurp.wildcardPath"]`);

  if (browseBtn && pathInput) {
    browseBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      const picker = new FilePicker({
        type:     'image',
        current:  pathInput.value || '',
        callback: (selectedPath) => {
          pathInput.value = selectedPath;
          pathInput.dispatchEvent(new Event('change', { bubbles: true }));
        },
      });
      picker.render(true);
    });
  }

  const imageInput   = root.querySelector('[name="texture.src"]');
  const insertTarget = imageInput?.closest('.form-group');

  if (insertTarget) {
    insertTarget.after(fragment);
  } else {
    const tab = root.querySelector('.tab[data-tab="appearance"]');
    if (tab) tab.prepend(fragment);
  }
}
