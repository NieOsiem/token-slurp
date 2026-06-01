import { MODULE_ID } from './constants.js';
import { resolveWildcard, resolveDisplayUrls, resolveDisplayUrlsProgressive, isVideo, parseFilenameMetadata } from './wildcard.js';
import { FLAGS } from './constants.js';

/**
 * Fast path: read token flags and resolve the wildcard file list.
 * No thumbnail work — just the files array and currentSrc.
 * Returns null if the token has no active wildcard, or if no files match.
 *
 * Use this when you want to render a grid immediately with placeholders
 * and fill in display URLs progressively.
 *
 * @param {TokenDocument} tokenDoc
 * @returns {Promise<{files: string[], currentSrc: string, thumbMode: string}|null>}
 */
export async function getTokenFiles(tokenDoc) {
  const flags     = tokenDoc.flags?.[MODULE_ID] ?? {};
  const active    = flags[FLAGS.WILDCARD_ACTIVE];
  const rawPath   = flags[FLAGS.WILDCARD_PATH];
  const thumbMode = flags[FLAGS.THUMB_MODE] ?? 'auto';

  if (!active || !rawPath) return null;

  const files = await resolveWildcard(rawPath);
  if (!files.length) return null;

  return { files, currentSrc: tokenDoc.texture?.src ?? '', thumbMode };
}

/**
 * Build the full grid dataset for a token, including resolved display URLs.
 * Returns null if the token has no active wildcard.
 *
 * @param {TokenDocument} tokenDoc
 * @returns {Promise<{files: string[], displayMap: Map<string,string>, currentSrc: string}|null>}
 */
export async function buildGridData(tokenDoc) {
  const result = await getTokenFiles(tokenDoc);
  if (!result) return null;

  const { files, currentSrc, thumbMode } = result;
  const displayMap = await resolveDisplayUrls(files, thumbMode);

  return { files, displayMap, currentSrc };
}

/**
 * (`_name_Sir Roland_`, `_size_2_`, `_scale_1.5_`)
 *
 * @param {TokenDocument} tokenDoc
 * @param {string}        newSrc
 * @returns {object}  Plain update object (no animation options)
 */
export function buildTokenImageUpdate(tokenDoc, newSrc) {
  const newMeta  = parseFilenameMetadata(newSrc);
  const prevMeta = parseFilenameMetadata(tokenDoc.texture?.src ?? '');
  const proto    = tokenDoc.actor?.prototypeToken;
  const data     = { 'texture.src': newSrc };

  // ── Token name ──────────────────────────────────────────────────────────────
  if ('name' in newMeta) {
    data.name = newMeta.name;
  } else if ('name' in prevMeta && proto !== undefined) {
    data.name = proto.name ?? tokenDoc.name;
  }

  // ── Token size (square grid units) ─────────────────────────────────────────
  if ('size' in newMeta) {
    const size = parseFloat(newMeta.size);
    if (!isNaN(size) && size > 0) {
      data.width  = size;
      data.height = size;
    }
  } else if ('size' in prevMeta && proto !== undefined) {
    data.width  = proto.width  ?? 1;
    data.height = proto.height ?? 1;
  }

  // ── Token scale (texture ratio) ─────────────────────────────────────────────
  if ('scale' in newMeta) {
    const scale = parseFloat(newMeta.scale);
    if (!isNaN(scale) && scale > 0) {
      data['texture.scaleX'] = scale;
      data['texture.scaleY'] = scale;
    }
  } else if ('scale' in prevMeta && proto !== undefined) {
    data['texture.scaleX'] = proto.texture?.scaleX ?? 1;
    data['texture.scaleY'] = proto.texture?.scaleY ?? 1;
  }

  return data;
}

/**
 * Switch a token to a new image, applying any metadata encoded in the filename.
 * 'none' animation is a fade with 0 duration.
 * @param {TokenDocument} tokenDoc
 * @param {string}        newSrc
 * @param {string}        [animation] — 'none' | any TokenAnimationTransition value
 * @param {number}        [duration]  — animation duration in milliseconds
 * @returns {Promise<void>}
 */
export async function switchTokenImage(tokenDoc, newSrc, animation = 'none', duration = 800) {
  const transition = animation === 'none' ? 'fade' : animation;
  const ms         = animation === 'none' ? 0      : duration;

  await tokenDoc.update(
    buildTokenImageUpdate(tokenDoc, newSrc),
    { animation: { transition, duration: ms } },
  );
}

/**
 * Render an image grid into a container element.
 * Supports video (webm/mp4) with hover-autoplay.
 *
 * Cells with no entry in displayMap (or whose entry is null/undefined) render
 * as loading placeholders (.ts-cell--loading) so the grid can appear before
 * all display URLs are resolved.
 *
 * @param {object}   opts
 * @param {HTMLElement}         opts.container    — element to render into
 * @param {string[]}            opts.files        — ordered list of original paths
 * @param {Map<string,string>}  opts.displayMap   — original → display URL mapping (may be partial)
 * @param {string}              opts.currentSrc   — currently active image path
 * @param {number}              opts.cellWidth
 * @param {number}              opts.cellHeight
 * @param {number|null}         opts.cols         — grid columns (null = css auto-fill)
 * @param {function}            opts.onSelect     — async (filePath) => void
 * @param {number}              [opts.zoom=1]     — scale factor 1.0–2.0
 * @param {string}              [opts.zoomOrigin='center center'] — CSS transform-origin
 * @param {boolean}             [opts.showMetaOverlay=false] — overlay name/size/scale badge on cells
 * @returns {{ updateCellDisplay: (filePath: string, url: string) => void }}
 *   Call updateCellDisplay to swap a loading placeholder for a real image at any time after render.
 */
export function renderImageGrid(opts) {
  const {
    container, files, displayMap, currentSrc,
    cellWidth, cellHeight, cols, onSelect,
    zoom = 1, zoomOrigin = 'center center',
    showMetaOverlay = false,
  } = opts;

  container.innerHTML = '';
  container.style.setProperty('--ts-cell-w',     `${cellWidth}px`);
  container.style.setProperty('--ts-cell-h',     `${cellHeight}px`);
  container.style.setProperty('--ts-zoom',        String(zoom));
  container.style.setProperty('--ts-zoom-origin', zoomOrigin);
  if (cols !== null) container.style.setProperty('--ts-cols', String(cols));

  // Lazy mode: every display URL equals its source file (no thumbnails generated).
  // We only engage the IntersectionObserver path when displayMap is fully populated
  // AND every value equals its file (i.e. pure lazy mode, no partial thumb maps).
  // Checked by key lookup rather than index so insertion order doesn't matter.
  const isFullyPopulated = files.every(f => displayMap.has(f));
  const isLazy = isFullyPopulated && files.every(f => displayMap.get(f) === f);

  // Two separate observers, created once and shared across all cells in lazy mode.
  // imgObserver is one-shot: unobserves after the <img> is created.
  // vidObserver is continuous: plays when visible, pauses when not.
  const imgObserver = isLazy ? new IntersectionObserver(_onLazyImgEntry, {
    root: container, rootMargin: '200px', threshold: 0,
  }) : null;

  const vidObserver = isLazy ? new IntersectionObserver(_onVideoVisibilityEntry, {
    root: container, rootMargin: '0px', threshold: 0,
  }) : null;

  // Index cells by filePath for O(1) lookups from updateCellDisplay
  /** @type {Map<string, HTMLElement>} */
  const cellMap = new Map();

  for (const filePath of files) {
    const displayUrl = displayMap.get(filePath);
    const isCurrent  = filePath === currentSrc;
    const vid        = isVideo(filePath);

    const cell = document.createElement('div');
    cell.className   = `ts-cell${isCurrent ? ' ts-cell--active' : ''}`;
    cell.dataset.src = filePath;
    cell.title       = filePath.split('/').pop();

    if (!displayUrl) {
      // No display URL yet — render as a shimmer placeholder
      cell.classList.add('ts-cell--loading');
    } else if (isLazy) {
      if (vid) {
        vidObserver.observe(cell);
      } else {
        cell.dataset.lazySrc = displayUrl;
        imgObserver.observe(cell);
      }
    } else {
      _appendMedia(cell, displayUrl, vid);
    }

    if (showMetaOverlay) _appendMetaOverlay(cell, filePath);

    cell.addEventListener('click', async () => {
      container.querySelectorAll('.ts-cell--active').forEach(c => c.classList.remove('ts-cell--active'));
      cell.classList.add('ts-cell--active');
      await onSelect(filePath);
    });

    container.appendChild(cell);
    cellMap.set(filePath, cell);
  }

  /**
   * Swap a loading placeholder for a real image/video.
   * Safe to call even if the container has been removed from the DOM (no-op).
   *
   * @param {string} filePath   — the original file path (key into cellMap)
   * @param {string} url        — the display URL to render (thumb or original)
   */
  function updateCellDisplay(filePath, url) {
    const cell = cellMap.get(filePath);
    if (!cell || !cell.isConnected) return;
    if (!cell.classList.contains('ts-cell--loading')) return;

    cell.classList.remove('ts-cell--loading');
    _appendMedia(cell, url, isVideo(filePath));
  }

  return { updateCellDisplay };
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
 * @param {string}      filePath
 */
function _appendMetaOverlay(cell, filePath) {
  const meta = parseFilenameMetadata(filePath);
  if (!Object.keys(meta).length) return;

  const overlay = document.createElement('div');
  overlay.className = 'ts-cell-meta';

  if ('name'  in meta) overlay.append(_metaLine(`Name: ${meta.name}`));
  if ('size'  in meta) overlay.append(_metaLine(`Size: ${meta.size}`));
  if ('scale' in meta) overlay.append(_metaLine(`Scale: ${meta.scale}`));

  cell.appendChild(overlay);
}

/** @param {string} text @returns {HTMLElement} */
function _metaLine(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
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