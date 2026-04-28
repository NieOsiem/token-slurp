import { MODULE_ID } from './constants.js';
import { resolveWildcard, resolveDisplayUrls, isVideo } from './wildcard.js';
import { FLAGS } from './constants.js';

/**
 * Build the full grid dataset for a token.
 * Returns null if the token has no active wildcard.
 * @param {TokenDocument} tokenDoc
 * @returns {Promise<{files: string[], displayMap: Map<string,string>, currentSrc: string}|null>}
 */
export async function buildGridData(tokenDoc) {
  const flags     = tokenDoc.flags?.[MODULE_ID] ?? {};
  const active    = flags[FLAGS.WILDCARD_ACTIVE];
  const rawPath   = flags[FLAGS.WILDCARD_PATH];
  const thumbMode = flags[FLAGS.THUMB_MODE] ?? 'auto';

  if (!active || !rawPath) return null;

  const files      = await resolveWildcard(rawPath);
  if (!files.length) return null;

  const displayMap = await resolveDisplayUrls(files, thumbMode);
  const currentSrc = tokenDoc.texture?.src ?? '';

  return { files, displayMap, currentSrc };
}

/**
 * Switch a token to a new image.
 * 'none' is a fade with 0 duration
 * @param {TokenDocument} tokenDoc
 * @param {string}        newSrc      — full path to the new image
 * @param {string}        [animation] — 'none' | any TokenAnimationTransition value
 * @param {number}        [duration]  — animation duration in milliseconds
 * @returns {Promise<void>}
 */
export async function switchTokenImage(tokenDoc, newSrc, animation = 'none', duration = 800) {
  const transition = animation === 'none' ? 'fade' : animation;
  const ms         = animation === 'none' ? 0      : duration;

  await tokenDoc.update(
    { 'texture.src': newSrc },
    { animation: { transition, duration: ms } },
  );
}

/**
 * Render an image grid into a container element.
 * Supports video (webm/mp4) with hover-autoplay.
 *
 * @param {object}   opts
 * @param {HTMLElement}         opts.container    — element to render into
 * @param {string[]}            opts.files        — ordered list of original paths
 * @param {Map<string,string>}  opts.displayMap   — original → display URL mapping
 * @param {string}              opts.currentSrc   — currently active image path
 * @param {number}              opts.cellWidth
 * @param {number}              opts.cellHeight
 * @param {number|null}         opts.cols         — grid columns (null = css auto-fill)
 * @param {function}            opts.onSelect     — async (filePath) => void
 * @param {number}              [opts.zoom=1]     — scale factor 1.0–2.0
 * @param {string}              [opts.zoomOrigin='center center'] — CSS transform-origin
 */
export function renderImageGrid(opts) {
  const {
    container, files, displayMap, currentSrc,
    cellWidth, cellHeight, cols, onSelect,
    zoom = 1, zoomOrigin = 'center center',
  } = opts;

  container.innerHTML = '';
  container.style.setProperty('--ts-cell-w',     `${cellWidth}px`);
  container.style.setProperty('--ts-cell-h',     `${cellHeight}px`);
  container.style.setProperty('--ts-zoom',        String(zoom));
  container.style.setProperty('--ts-zoom-origin', zoomOrigin);
  if (cols !== null) container.style.setProperty('--ts-cols', String(cols));

  // Lazy mode: every display URL equals its source file (no thumbnails generated)
  const isLazy = [...displayMap.values()].every((v, i) => v === files[i]);

  // Two separate observers, created once and shared across all cells in lazy mode.
  // imgObserver is one-shot: unobserves after the <img> is created.
  // vidObserver is continuous: plays when visible, pauses when not.
  const imgObserver = isLazy ? new IntersectionObserver(_onLazyImgEntry, {
    root: container, rootMargin: '200px', threshold: 0,
  }) : null;

  const vidObserver = isLazy ? new IntersectionObserver(_onVideoVisibilityEntry, {
    root: container, rootMargin: '0px', threshold: 0,
  }) : null;

  for (const filePath of files) {
    const displayUrl = displayMap.get(filePath) ?? filePath;
    const isCurrent  = filePath === currentSrc;
    const vid        = isVideo(filePath);

    const cell = document.createElement('div');
    cell.className   = `ts-cell${isCurrent ? ' ts-cell--active' : ''}`;
    cell.dataset.src = filePath;
    cell.title       = filePath.split('/').pop();

    if (isLazy) {
      if (vid) {
        // Videos: autoplay when entering viewport, pause when leaving
        vidObserver.observe(cell);
      } else {
        // Images: load when approaching the viewport, then unobserve
        cell.dataset.lazySrc = displayUrl;
        imgObserver.observe(cell);
      }
    } else {
      _appendMedia(cell, displayUrl, vid);
    }

    cell.addEventListener('click', async () => {
      container.querySelectorAll('.ts-cell--active').forEach(c => c.classList.remove('ts-cell--active'));
      cell.classList.add('ts-cell--active');
      await onSelect(filePath);
    });

    container.appendChild(cell);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** One-shot observer: load image when it approaches the viewport, then stop watching. */
function _onLazyImgEntry(entries, obs) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const cell = entry.target;
    const src  = cell.dataset.lazySrc;
    if (src && !cell.querySelector('img')) {
      const img   = document.createElement('img');
      img.src     = src;
      img.loading = 'lazy';
      cell.appendChild(img);
    }
    obs.unobserve(cell);
  }
}

/**
 * Continuous observer: play video when visible, pause when not.
 * Creates the <video> element on first entry to defer decoding cost.
 */
function _onVideoVisibilityEntry(entries) {
  for (const entry of entries) {
    const cell = entry.target;
    let   vid  = cell.querySelector('video');

    if (entry.isIntersecting) {
      if (!vid) {
        vid             = document.createElement('video');
        vid.src         = cell.dataset.src;
        vid.muted       = true;
        vid.loop        = true;
        vid.playsInline = true;
        vid.autoplay    = true;
        cell.appendChild(vid);
      } else {
        vid.play().catch(() => {});
      }
    } else if (vid) {
      vid.pause();
    }
  }
}

/**
 * @param {HTMLElement} cell
 * @param {string}      displayUrl
 * @param {boolean}     vid
 */
function _appendMedia(cell, displayUrl, vid) {
  if (!vid) {
    const img = document.createElement('img');
    img.src     = displayUrl;
    img.loading = 'lazy';
    cell.appendChild(img);
    return;
  }

  // Video cells: show a static thumbnail, swap to <video> on hover
  const img   = document.createElement('img');
  img.src     = displayUrl;
  img.loading = 'lazy';
  cell.appendChild(img);

  let videoEl = null;

  cell.addEventListener('mouseenter', () => {
    if (videoEl) return;
    videoEl = document.createElement('video');
    videoEl.src         = cell.dataset.src;
    videoEl.autoplay    = true;
    videoEl.muted       = true;
    videoEl.loop        = true;
    videoEl.playsInline = true;
    videoEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;';
    cell.appendChild(videoEl);
  }, { passive: true });

  cell.addEventListener('mouseleave', () => {
    if (!videoEl) return;
    videoEl.pause();
    videoEl.remove();
    videoEl = null;
  }, { passive: true });
}
