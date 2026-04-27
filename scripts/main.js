
import { MODULE_ID, FLAGS }         from './constants.js';
import { registerSettings }         from './settings.js';
import { registerTokenConfigHooks } from './token-config.js';
import { registerTokenHudHooks }    from './token-hud.js';
import { initSlurpWindow }          from './ui-window.js';
import { resolveWildcard, getResolveCache }   from './wildcard.js';
import { API }                      from './api.js';

// init
// Single init hook, everything requiring foundry globals

Hooks.once('init', () => {
  registerSettings();
  registerTokenConfigHooks();
  registerTokenHudHooks();
  initSlurpWindow();
  console.log(`${MODULE_ID} | Initialised`);
});

Hooks.once('ready', () => {
  game[MODULE_ID] = API;
  console.log(`${MODULE_ID} | Ready — API available at game['${MODULE_ID}']`);
});

/**
 * preCreateToken fires synchronously before a TokenDocument is saved.
 * @param {TokenDocument} tokenDoc
 */
Hooks.on('preCreateToken', (tokenDoc, _createData, _options, _userId) => {
  const flags = tokenDoc.flags?.[MODULE_ID] ?? {};

  if (!flags[FLAGS.WILDCARD_ACTIVE]) return;
  const rawPath = flags[FLAGS.WILDCARD_PATH];
  if (!rawPath) return;

  if (flags[FLAGS.RANDOMIZED]) return;

  const cached = getResolveCache(rawPath);

  if (cached && cached.length) {
    const chosen = cached[Math.floor(Math.random() * cached.length)];
    tokenDoc.updateSource({
      'texture.src': chosen,
      [`flags.${MODULE_ID}.${FLAGS.RANDOMIZED}`]: true,
    });
  } else {
    tokenDoc.updateSource({
      [`flags.${MODULE_ID}._pendingRandomize`]: true,
    });
  }
});

/**
 * @param {TokenDocument} tokenDoc
 */
Hooks.on('createToken', async (tokenDoc, _options, _userId) => {
  const flags = tokenDoc.flags?.[MODULE_ID] ?? {};

  if (!flags['_pendingRandomize']) return;
  if (flags[FLAGS.RANDOMIZED]) return;

  const rawPath = flags[FLAGS.WILDCARD_PATH];
  if (!rawPath) return;

  const files = await resolveWildcard(rawPath);
  if (!files.length) {
    console.warn(`${MODULE_ID} | No images found for wildcard: ${rawPath}`);
    await tokenDoc.update({ [`flags.${MODULE_ID}._pendingRandomize`]: false });
    return;
  }

  const chosen = files[Math.floor(Math.random() * files.length)];
  await tokenDoc.update({
    'texture.src': chosen,
    [`flags.${MODULE_ID}.${FLAGS.RANDOMIZED}`]:      true,
    [`flags.${MODULE_ID}._pendingRandomize`]:         false,
  });
});
