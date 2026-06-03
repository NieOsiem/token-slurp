import { MODULE_ID, THUMB_SIZE, THUMB_AUTO_THRESHOLD, THUMB_MODES } from './constants.js';
import { getSetting, SETTINGS } from './settings.js';

// ── Session-level cache ──────────────────────────────────────────────────────
/** @type {Map<string, string[]>} */
const _resolveCache = new Map();

export function clearResolveCache() {
  _resolveCache.clear();
}

/**
 * Synchronously return a cached result for a wildcard path, or null if not yet cached.
 * @param {string} wildcardPath
 * @returns {string[]|null}
 */
export function getResolveCache(wildcardPath) {
  return _resolveCache.get(wildcardPath?.trim()) ?? null;
}

// ── Glob helpers ─────────────────────────────────────────────────────────────

function segmentToRegex(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function isSupportedMedia(path) {
  return /\.(png|jpg|jpeg|gif|webp|svg|webm|mp4|ogg)$/i.test(path);
}

// ── Core resolver ─────────────────────────────────────────────────────────────

export async function resolveWildcard(wildcardPath) {
  const raw = wildcardPath?.trim();
  if (!raw) return [];
  if (_resolveCache.has(raw)) return _resolveCache.get(raw);

  const segments = raw.split('/');
  const lastIdx  = segments.length - 1;

  let frontier = [''];

  for (let i = 0; i < lastIdx; i++) {
    const seg = segments[i];

    if (!seg.includes('*')) {
      frontier = frontier.map(prefix => joinPath(prefix, seg));
      continue;
    }

    const regex        = segmentToRegex(seg);
    const nextFrontier = [];

    await Promise.all(frontier.map(async prefix => {
      const dirs = await browseDirectories(prefix);
      for (const dir of dirs) {
        const name = dir.split('/').pop();
        if (regex.test(name)) nextFrontier.push(dir);
      }
    }));

    frontier = nextFrontier;
    if (!frontier.length) break;
  }

  const finalSeg  = segments[lastIdx];
  const fileRegex = segmentToRegex(finalSeg);
  const results   = [];

  await Promise.all(frontier.map(async prefix => {
    const files = await browseFiles(prefix);
    for (const file of files) {
      const name = file.split('/').pop();
      if (fileRegex.test(name) && isSupportedMedia(file)) results.push(file);
    }
  }));

  const unique = [...new Set(results)].sort();
  _resolveCache.set(raw, unique);
  return unique;
}

// ── FilePicker wrappers ───────────────────────────────────────────────────────

async function browseDirectories(path) {
  try {
    const result = await FilePicker.browse('data', path || '.');
    return result.dirs ?? [];
  } catch { return []; }
}

async function browseFiles(path) {
  try {
    const result = await FilePicker.browse('data', path || '.');
    return result.files ?? [];
  } catch { return []; }
}

function joinPath(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
}

// ── Thumbnail generation ─────────────────────────────────────────────────────

async function _browseThumbDirOnce(storageRoot) {
  try {
    const result = await FilePicker.browse('data', storageRoot);
    return new Set((result.files ?? []).map(f => f.split('/').pop()));
  } catch { return new Set(); }
}

/**
 * Call onFileReady(filePath, displayUrl) as each display URL becomes known.
 * @param {string[]}  files
 * @param {string}    thumbMode
 * @param {function}  onFileReady
 */
export async function resolveDisplayUrlsProgressive(files, thumbMode, onFileReady) {
  if (!shouldUseThumb(files.length, thumbMode)) {
    for (const f of files) onFileReady(f, f);
    return;
  }

  const storageRoot   = getSetting(SETTINGS.THUMB_STORAGE_PATH);
  const existingNames = await _browseThumbDirOnce(storageRoot);
  const toGenerate    = [];

  for (const file of files) {
    const thumbPath = thumbPathFor(file, storageRoot);
    if (existingNames.has(thumbPath.split('/').pop())) {
      onFileReady(file, thumbPath);
    } else {
      toGenerate.push({ file, thumbPath });
    }
  }

  if (!toGenerate.length) return;

  const BATCH = 8;
  for (let i = 0; i < toGenerate.length; i += BATCH) {
    const batch = toGenerate.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ file, thumbPath }) => {
      const url = await ensureThumb(file, thumbPath, false, existingNames);
      onFileReady(file, url);
    }));
  }
}

/**
 * @param {string[]} files
 * @param {string}   thumbMode
 * @returns {Promise<Map<string,string>>}
 */
export async function resolveDisplayUrls(files, thumbMode) {
  const map = new Map();
  await resolveDisplayUrlsProgressive(files, thumbMode, (f, url) => map.set(f, url));
  return map;
}

/**
 * @param {number} count
 * @param {string} mode
 * @returns {boolean}
 */
export function shouldUseThumb(count, mode) {
  if (mode === THUMB_MODES.FORCE) return true;
  if (mode === THUMB_MODES.LAZY)  return false;
  return count < THUMB_AUTO_THRESHOLD;
}

/**
 * @param {string} sourceFile
 * @param {string} storageRoot
 * @returns {string}
 */
export function thumbPathFor(sourceFile, storageRoot) {
  const hash = simpleHash(sourceFile);
  return `${storageRoot}/${hash}.webp`;
}

async function ensureDirectory(dirPath) {
  const parts    = dirPath.split('/').filter(Boolean);
  let   building = '';
  for (const part of parts) {
    building = building ? `${building}/${part}` : part;
    try {
      await FilePicker.createDirectory('data', building);
    } catch (e) {
      if (!e?.message?.includes('already exists') && !e?.message?.includes('EEXIST')) throw e;
    }
  }
}

/**
 * @param {string}      sourcePath
 * @param {string}      thumbPath
 * @param {boolean}     [force=false]
 * @param {Set<string>} [existingNames=null]
 * @returns {Promise<string>}
 */
export async function ensureThumb(sourcePath, thumbPath, force = false, existingNames = null) {
  const thumbDir  = thumbPath.substring(0, thumbPath.lastIndexOf('/'));
  const thumbName = thumbPath.split('/').pop();

  let exists = false;
  if (existingNames !== null) {
    exists = existingNames.has(thumbName);
  } else {
    try {
      const result = await FilePicker.browse('data', thumbDir);
      exists = (result.files ?? []).some(f => f.split('/').pop() === thumbName);
    } catch { /* directory doesn't exist yet */ }
  }

  if (exists && !force) return thumbPath;

  try {
    const blob = await generateThumbBlob(sourcePath);
    if (!blob) return sourcePath;

    const file = new File([blob], thumbName, { type: 'image/webp' });
    await ensureDirectory(thumbDir);
    await FilePicker.upload('data', thumbDir, file, {}, { notify: false });
    return thumbPath;
  } catch (err) {
    console.warn(`[${MODULE_ID}] Thumb generation failed for ${sourcePath}:`, err);
    return sourcePath;
  }
}

async function generateThumbBlob(src) {
  return new Promise(resolve => {
    const isVid = isVideo(src);
    const el    = isVid ? document.createElement('video') : document.createElement('img');

    el.crossOrigin = 'anonymous';

    const draw = () => {
      try {
        const thumbSize = getSetting(SETTINGS.THUMB_SIZE);
        const canvas    = document.createElement('canvas');
        canvas.width  = thumbSize;
        canvas.height = thumbSize;
        const ctx  = canvas.getContext('2d');
        const sw   = isVid ? el.videoWidth  : el.naturalWidth;
        const sh   = isVid ? el.videoHeight : el.naturalHeight;
        const side = Math.min(sw, sh);
        const ox   = (sw - side) / 2;
        const oy   = (sh - side) / 2;
        ctx.drawImage(el, ox, oy, side, side, 0, 0, thumbSize, thumbSize);
        canvas.toBlob(blob => resolve(blob), 'image/webp', 0.85);
      } catch { resolve(null); }
    };

    if (isVid) {
      el.preload  = 'metadata';
      el.muted    = true;
      el.src      = src;
      el.addEventListener('loadedmetadata', () => {
        el.currentTime = Math.min(0.1, (el.duration || 1) * 0.1);
      }, { once: true });
      el.addEventListener('seeked', draw,              { once: true });
      el.addEventListener('error', () => resolve(null), { once: true });
      el.load();
    } else {
      el.addEventListener('load',  draw,              { once: true });
      el.addEventListener('error', () => resolve(null), { once: true });
      el.src = src;
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function simpleHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function isVideo(path) {
  return /\.(webm|mp4|ogg)$/i.test(path);
}

// ── Filename metadata parsing ─────────────────────────────────────────────────

/**
 * Ordered list of metadata keys recognised in filenames.
 * Includes 'group' for explicit grouping in the picker window.
 * @type {readonly string[]}
 */
const FILENAME_META_KEYS = Object.freeze(['name', 'size', 'scale', 'group']);

/**
 * Parse metadata encoded in a filename using the `_key_value_` convention.
 * @param {string} filepath
 * @returns {{ name?: string, size?: string, scale?: string, group?: string }}
 */
export function parseFilenameMetadata(filepath) {
  if (!filepath) return {};

  let filename = filepath.split('/').pop();
  try { filename = decodeURIComponent(filename); } catch (e) {
    console.warn(`Could not decode filename: ${filename}`, e);
  }

  const stem      = filename.replace(/\.[^.]+$/, '');
  const stemLower = stem.toLowerCase();
  const meta      = {};

  for (const key of FILENAME_META_KEYS) {
    const marker = `_${key}_`;
    const idx    = stemLower.indexOf(marker);
    if (idx === -1) continue;

    const valueStart = idx + marker.length;
    let   valueEnd   = stem.indexOf('_', valueStart);
    if (valueEnd === -1) valueEnd = stem.length;

    const value = stem.slice(valueStart, valueEnd).trim();
    if (value) meta[key] = value;
  }

  return meta;
}