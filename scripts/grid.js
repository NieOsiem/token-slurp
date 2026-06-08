import { MODULE_ID } from './constants.js';
import { resolveWildcard, resolveDisplayUrls, resolveDisplayUrlsProgressive, isVideo, parseFilenameMetadata } from './wildcard.js';
import { FLAGS } from './constants.js';

/**
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
 * Partition a file list into named groups based on _group_ and optionally _name_ metadata tags.
 * Explicit _group_ tags always win. _name_ grouping is optional and threshold-gated.
 * Files with no qualifying group land in an Ungrouped bucket at the end.
 *
 * @param {string[]} files
 * @param {object}   opts
 * @param {boolean}  opts.nameGroupEnabled   — group by _name_ tag in addition to _group_
 * @param {number}   opts.nameGroupMinCount  — minimum files for a name group to qualify
 * @returns {{ groups: Array<{key:string, label:string, files:string[]}>, hasGroups: boolean }}
 */
export function computeGroups(files, { nameGroupEnabled = false, nameGroupMinCount = 3 } = {}) {
  const explicitMap = new Map();
  const remaining   = [];

  for (const file of files) {
    const meta = parseFilenameMetadata(file);
    if (meta.group) {
      if (!explicitMap.has(meta.group)) explicitMap.set(meta.group, []);
      explicitMap.get(meta.group).push(file);
    } else {
      remaining.push(file);
    }
  }

  const groups = [...explicitMap.entries()].map(([key, groupFiles]) => ({ key, label: key, files: groupFiles }));

  if (nameGroupEnabled && remaining.length) {
    const nameMap   = new Map();
    const ungrouped = [];

    for (const file of remaining) {
      const meta = parseFilenameMetadata(file);
      if (meta.name) {
        if (!nameMap.has(meta.name)) nameMap.set(meta.name, []);
        nameMap.get(meta.name).push(file);
      } else {
        ungrouped.push(file);
      }
    }

    for (const [key, nameFiles] of nameMap) {
      if (nameFiles.length >= nameGroupMinCount) {
        groups.push({ key, label: key, files: nameFiles });
      } else {
        ungrouped.push(...nameFiles);
      }
    }

    if (groups.length > 0 && ungrouped.length) {
      groups.push({ key: '__ungrouped__', label: game.i18n.localize('TOKEN_SLURP.window.groupUngrouped'), files: ungrouped });
    }
  } else if (remaining.length && groups.length > 0) {
    groups.push({ key: '__ungrouped__', label: game.i18n.localize('TOKEN_SLURP.window.groupUngrouped'), files: remaining });
  }

  return { groups, hasGroups: groups.some(g => g.key !== '__ungrouped__') };
}

/**
 * Find a column count >= defaultCols that reduces orphaned images in the last row.
 * Only triggers when the last row is less than half full.
 * Returns null if no useful improvement exists within a reasonable range.
 *
 * @param {number} fileCount
 * @param {number} defaultCols
 * @returns {number|null}
 */
export function balancedCols(fileCount, defaultCols) {
  if (!fileCount || !defaultCols || fileCount <= defaultCols) return null;
  const remainder = fileCount % defaultCols;
  if (remainder === 0 || remainder >= Math.ceil(defaultCols / 2)) return null;
  const defaultRows = Math.ceil(fileCount / defaultCols);
  const cap = defaultCols + Math.max(4, Math.ceil(defaultCols * 0.5));
  for (let c = defaultCols + 1; c <= cap; c++) {
    if (Math.ceil(fileCount / c) < defaultRows) return c;
  }
  return null;
}

/**
 * (`_name_Sir Roland_`, `_size_2_`, `_scale_1.5_`)
 *
 * @param {TokenDocument} tokenDoc
 * @param {string}        newSrc
 * @returns {object}
 */
export function buildTokenImageUpdate(tokenDoc, newSrc) {
  const newMeta  = parseFilenameMetadata(newSrc);
  const prevMeta = parseFilenameMetadata(tokenDoc.texture?.src ?? '');
  const proto    = tokenDoc.actor?.prototypeToken;
  const data     = { 'texture.src': newSrc };

  if ('name' in newMeta) {
    data.name = newMeta.name;
  } else if ('name' in prevMeta && proto !== undefined) {
    data.name = proto.name ?? tokenDoc.name;
  }

  if ('size' in newMeta) {
    const size = parseFloat(newMeta.size);
    if (!isNaN(size) && size > 0) { data.width = size; data.height = size; }
  } else if ('size' in prevMeta && proto !== undefined) {
    data.width  = proto.width  ?? 1;
    data.height = proto.height ?? 1;
  }

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
 * @param {TokenDocument} tokenDoc
 * @param {string}        newSrc
 * @param {string}        [animation]
 * @param {number}        [duration]
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
 * Supports flat and grouped layouts, video hover-autoplay, lazy loading,
 * and progressive thumbnail fill-in.
 *
 * @param {object}   opts
 * @param {HTMLElement}         opts.container
 * @param {string[]}            opts.files           — flat ordered list (used when no groups)
 * @param {Map<string,string>}  opts.displayMap       — original → display URL (may be partial)
 * @param {string}              opts.currentSrc
 * @param {number}              opts.cellWidth
 * @param {number}              opts.cellHeight
 * @param {number|null}         opts.cols             — grid columns (null = css auto-fill)
 * @param {function}            opts.onSelect         — async (filePath) => void
 * @param {number}              [opts.zoom=1]
 * @param {string}              [opts.zoomOrigin='center center']
 * @param {boolean}             [opts.showMetaOverlay=false]
 * @param {Array}               [opts.groups]         — from computeGroups(); triggers grouped layout
 * @returns {{ updateCellDisplay: function, groupElements: Map }}
 */
export function renderImageGrid(opts) {
  const {
    container, files, displayMap, currentSrc,
    cellWidth, cellHeight, cols, onSelect,
    zoom = 1, zoomOrigin = 'center center',
    showMetaOverlay = false,
    groups,
  } = opts;

  container.innerHTML = '';
  container.classList.remove('ts-grouped');
  container.style.setProperty('--ts-cell-w',     `${cellWidth}px`);
  container.style.setProperty('--ts-cell-h',     `${cellHeight}px`);
  container.style.setProperty('--ts-zoom',        String(zoom));
  container.style.setProperty('--ts-zoom-origin', zoomOrigin);
  if (cols !== null) container.style.setProperty('--ts-cols', String(cols));

  const useGroups = Array.isArray(groups) && groups.some(g => g.key !== '__ungrouped__');
  const allFiles  = useGroups ? groups.flatMap(g => g.files) : (files ?? []);

  // Lazy mode: IntersectionObserver path — only when displayMap is fully populated
  // with identity mappings (every file maps to itself, no thumbnails).
  const isFullyPopulated = allFiles.every(f => displayMap.has(f));
  const isLazy = isFullyPopulated && allFiles.every(f => displayMap.get(f) === f);

  const imgObserver = isLazy ? new IntersectionObserver(_onLazyImgEntry, {
    root: container, rootMargin: '200px', threshold: 0,
  }) : null;
  const vidObserver = isLazy ? new IntersectionObserver(_onVideoVisibilityEntry, {
    root: container, rootMargin: '0px', threshold: 0,
  }) : null;

  /** @type {Map<string, HTMLElement>} */
  const cellMap = new Map();

  function createCell(filePath) {
    const displayUrl = displayMap.get(filePath);
    const isCurrent  = filePath === currentSrc;
    const vid        = isVideo(filePath);

    const cell       = document.createElement('div');
    cell.className   = `ts-cell${isCurrent ? ' ts-cell--active' : ''}`;
    cell.dataset.src = filePath;
    cell.title       = filePath.split('/').pop();

    if (!displayUrl) {
      cell.classList.add('ts-cell--loading');
    } else if (isLazy) {
      if (vid) { vidObserver.observe(cell); }
      else { cell.dataset.lazySrc = displayUrl; imgObserver.observe(cell); }
    } else {
      _appendMedia(cell, displayUrl, vid);
    }

    if (showMetaOverlay) _appendMetaOverlay(cell, filePath);

    let preloadTimeout;
    cell.addEventListener('mouseenter', () => {
      preloadTimeout = setTimeout(() => {
        if (globalThis.TextureLoader) globalThis.TextureLoader.loader.loadTexture(filePath).catch(() => {});
        else if (typeof loadTexture === 'function') loadTexture(filePath).catch(() => {});
      }, 150);
    }, { passive: true });
    cell.addEventListener('mouseleave', () => clearTimeout(preloadTimeout), { passive: true });

    cell.addEventListener('click', async () => {
      container.querySelectorAll('.ts-cell--active').forEach(c => c.classList.remove('ts-cell--active'));
      cell.classList.add('ts-cell--active');
      await onSelect(filePath);
    });

    cellMap.set(filePath, cell);
    return cell;
  }

  /** @type {Map<string, {el: HTMLElement, cellsEl: HTMLElement}>} */
  const groupElements = new Map();

  if (useGroups) {
    container.classList.add('ts-grouped');

    for (const group of groups) {
      const groupEl     = document.createElement('div');
      groupEl.className = `ts-group${group.key === '__ungrouped__' ? ' ts-group--ungrouped' : ''}`;

      const headerEl     = document.createElement('div');
      headerEl.className = 'ts-group-header';

      const labelEl       = document.createElement('span');
      labelEl.className   = 'ts-group-label';
      labelEl.textContent = group.label;

      const countEl       = document.createElement('span');
      countEl.className   = 'ts-group-count';
      countEl.textContent = `(${group.files.length})`;

      const toggleBtn     = document.createElement('button');
      toggleBtn.type      = 'button';
      toggleBtn.className = 'ts-group-toggle';
      toggleBtn.innerHTML = '<i class="fas fa-chevron-down"></i>';
      toggleBtn.addEventListener('click', ev => ev.stopPropagation());

      const ruleEl     = document.createElement('span');
      ruleEl.className = 'ts-group-rule';

      headerEl.append(labelEl, ruleEl, countEl, toggleBtn);
      headerEl.addEventListener('click', () => groupEl.classList.toggle('ts-group--collapsed'));

      const cellsEl     = document.createElement('div');
      cellsEl.className = 'ts-group-cells';
      for (const file of group.files) cellsEl.appendChild(createCell(file));

      groupEl.append(headerEl, cellsEl);
      container.appendChild(groupEl);
      groupElements.set(group.key, { el: groupEl, cellsEl });
    }
  } else {
    for (const filePath of allFiles) container.appendChild(createCell(filePath));
  }

  function updateCellDisplay(filePath, url) {
    const cell = cellMap.get(filePath);
    if (!cell || !cell.isConnected) return;
    if (!cell.classList.contains('ts-cell--loading')) return;
    cell.classList.remove('ts-cell--loading');
    _appendMedia(cell, url, isVideo(filePath));
  }

  return { updateCellDisplay, groupElements };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

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

function _appendMetaOverlay(cell, filePath) {
  const meta = parseFilenameMetadata(filePath);
  if (!Object.keys(meta).length) return;

  const overlay     = document.createElement('div');
  overlay.className = 'ts-cell-meta';

  if ('name'  in meta) overlay.append(_metaLine(`Name: ${meta.name}`));
  if ('size'  in meta) overlay.append(_metaLine(`Size: ${meta.size}`));
  if ('scale' in meta) overlay.append(_metaLine(`Scale: ${meta.scale}`));

  cell.appendChild(overlay);
}

function _metaLine(text) {
  const span       = document.createElement('span');
  span.textContent = text;
  return span;
}

function _appendMedia(cell, displayUrl, vid) {
  if (!vid) {
    const img   = document.createElement('img');
    img.src     = displayUrl;
    img.loading = 'lazy';
    cell.appendChild(img);
    return;
  }

  const img   = document.createElement('img');
  img.src     = displayUrl;
  img.loading = 'lazy';
  cell.appendChild(img);

  let videoEl = null;

  cell.addEventListener('mouseenter', () => {
    if (videoEl) return;
    videoEl             = document.createElement('video');
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