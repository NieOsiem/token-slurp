import { resolveWildcard, clearResolveCache } from './wildcard.js';
import { switchTokenImage } from './grid.js';

/** API
 * Example usage from a macro:
 *   await game['token-slurp'].switchImage(token.document, 'path/to/image.webp');
 *   const files = await game['token-slurp'].resolveWildcard('S/[star]/NPC/[star]Female[star]');
 */
export const API = {
  /**
   * Switch a token to a specific image.
   * @param {TokenDocument} tokenDoc
   * @param {string}        imagePath
   * @param {object}        [opts]
   * @param {string}        [opts.animation='none']    — 'none'|'fade'|'swirl'|'dots'
   * @param {number}        [opts.duration=800]        — ms
   */
  async switchImage(tokenDoc, imagePath, { animation = 'none', duration = 800 } = {}) {
    return switchTokenImage(tokenDoc, imagePath, animation, duration);
  },

  /**
   * Resolve a wildcard path to a list of matching file paths.
   * Results are cached for the session.
   * @param {string} wildcardPath
   * @returns {Promise<string[]>}
   */
  async resolveWildcard(wildcardPath) {
    return resolveWildcard(wildcardPath);
  },
  clearCache() {
    clearResolveCache();
  },
};
