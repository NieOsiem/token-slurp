import { MODULE_ID } from './constants.js';

export const MAX_FAVORITES = 10;

/**
 * Favourites live on the User document so they follow the player across
 * browsers/machines. One flag per wildcard path keeps writes small and avoids
 * Foundry's deep-merge behaviour on nested flag objects.
 */
function flagKey(scope) {
  return `fav:${scope}`;
}

/** @param {string} scope Wildcard path */
export function getFavorites(scope) {
  if (!scope) return [];

  const raw = game.user.getFlag(MODULE_ID, flagKey(scope));
  return Array.isArray(raw) ? raw.filter(p => typeof p === 'string') : [];
}

/**
 * Add or remove one file in a scope.
 * @param {string} scope Wildcard path
 * @param {string} file
 * @returns {Promise<{favorites: string[], added: boolean, limitReached: boolean}>}
 */
export async function toggleFavorite(scope, file) {
  if (!scope) return { favorites: [], added: false, limitReached: false };

  const list  = getFavorites(scope);
  const index = list.indexOf(file);

  if (index >= 0) {
    list.splice(index, 1);
  } else {
    if (list.length >= MAX_FAVORITES) {
      return { favorites: list, added: false, limitReached: true };
    }
    list.push(file);
  }

  if (list.length) await game.user.setFlag(MODULE_ID, flagKey(scope), list);
  else await game.user.unsetFlag(MODULE_ID, flagKey(scope));

  return { favorites: list, added: index < 0, limitReached: false };
}

/**
 * Drop favourites whose files no longer exist, so hidden entries can't occupy
 * the 10-slot cap. Writes only when something actually changed.
 * @param {string}      scope
 * @param {Set<string>} validPaths
 */
export async function pruneFavorites(scope, validPaths) {
  if (!scope) return;

  const list = getFavorites(scope);
  const kept = list.filter(p => validPaths.has(p));
  if (kept.length === list.length) return;

  if (kept.length) await game.user.setFlag(MODULE_ID, flagKey(scope), kept);
  else await game.user.unsetFlag(MODULE_ID, flagKey(scope));
}
