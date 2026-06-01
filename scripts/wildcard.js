import { MODULE_ID, THUMB_SIZE, THUMB_AUTO_THRESHOLD, THUMB_MODES } from './constants.js';
import { getSetting, SETTINGS } from './settings.js';

// ── Session-level cache ──────────────────────────────────────────────────────
/** @type {Map<string, string[]>} */
const _resolveCache = new Map();

// Clear the in-memory cache
export function clearResolveCache() {
  _resolveCache.clear();
}

/**
 * Synchronously return a cached result for a wildcard path, or null if not yet cached. Used by preCreateToken which cannot be async.
 * @param {string} wildcardPath
 * @returns {string[]|null}
 */
export function getResolveCache(wildcardPath) {
  return _resolveCache.get(wildcardPath?.trim()) ?? null;
}

// ── Glob helpers ─────────────────────────────────────────────────────────────

/**
 * Convert a single path segment that may contain `*` into a RegExp
 * @param {string} segment
 * @returns {RegExp}
 */
function segmentToRegex(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Return true if a filename extension is a supported image/video format */
function isSupportedMedia(path) {
  return /\.(png|jpg|jpeg|gif|webp|svg|webm|mp4|ogg)$/i.test(path);
}

// ── Core resolver ─────────────────────────────────────────────────────────────

// Resolve a wildcard path (e.g. S/[star]/NPC/[star]/Noble[star]Female[star])
// to a flat list of matching file paths. Walk segments left-to-right;
// wildcard directory segments expand via FilePicker.browse(); the final
// segment filters files by regex. Results are cached by raw path for the session.
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

    const regex       = segmentToRegex(seg);
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

  const finalSeg   = segments[lastIdx];
  const fileRegex  = segmentToRegex(finalSeg);
  const results    = [];

  await Promise.all(frontier.map(async prefix => {
    const files = await browseFiles(prefix);
    for (const file of files) {
      const name = file.split('/').pop();
      if (fileRegex.test(name) && isSupportedMedia(file)) {
        results.push(file);
      }
    }
  }));

  const unique = [...new Set(results)].sort();
  _resolveCache.set(raw, unique);
  return unique;
}

// ── FilePicker wrappers ───────────────────────────────────────────────────────

/**
 * Browse a directory and return subdirectory paths. Returns [] on any error (access denied, missing dir, etc.)
 * @param {string} path
 * @returns {Promise<string[]>}
 */
async function browseDirectories(path) {
  try {
    const result = await FilePicker.browse('data', path || '.');
    return (result.dirs ?? []);
  } catch {
    return [];
  }
}

async function browseFiles(path) {
  try {
    const result = await FilePicker.browse('data', path || '.');
    return (result.files ?? []);
  } catch {
    return [];
  }
}

/** Join path segments, collapsing double slashes, skipping empty parts */
function joinPath(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
}

// ── Thumbnail generation ─────────────────────────────────────────────────────

/**
 * Browse the thumbnail storage directory once and return a Set of existing filenames.
 * Returns an empty Set if the directory doesn't exist yet.
 * Centralises the directory listing so callers can do O(1) existence checks
 * instead of one FilePicker.browse per file.
 *
 * @param {string} storageRoot
 * @returns {Promise<Set<string>>}
 */
async function _browseThumbDirOnce(storageRoot) {
  try {
    const result = await FilePicker.browse('data', storageRoot);
    return new Set((result.files ?? []).map(f => f.split('/').pop()));
  } catch {
    // Storage directory doesn't exist yet — no thumbnails have been generated
    return new Set();
  }
}

/**
 * Given a list of image paths and a thumb mode, call onFileReady(filePath, displayUrl)
 * as each display URL becomes known:
 *   - Existing thumbnails fire immediately after a single directory listing.
 *   - Files that need generation fire when their thumbnail finishes.
 *   - Lazy-mode files (no thumbnails) all fire synchronously before returning.
 *
 * Safe to fire-and-forget; callbacks that target detached DOM nodes are harmless no-ops.
 *
 * @param {string[]}  files
 * @param {string}    thumbMode
 * @param {function}  onFileReady  — (filePath: string, displayUrl: string) => void
 */
export async function resolveDisplayUrlsProgressive(files, thumbMode, onFileReady) {
  if (!shouldUseThumb(files.length, thumbMode)) {
    // Lazy mode — files display as themselves; callbacks fire synchronously
    for (const f of files) onFileReady(f, f);
    return;
  }

  const storageRoot   = getSetting(SETTINGS.THUMB_STORAGE_PATH);
  const existingNames = await _browseThumbDirOnce(storageRoot);
  const toGenerate    = [];

  // One pass: fire immediately for cached thumbs, collect the rest for generation
  for (const file of files) {
    const thumbPath = thumbPathFor(file, storageRoot);
    if (existingNames.has(thumbPath.split('/').pop())) {
      onFileReady(file, thumbPath);
    } else {
      toGenerate.push({ file, thumbPath });
    }
  }

  if (!toGenerate.length) return;

  // Generate missing thumbnails in batches; fire callback as each completes
  const BATCH = 8;
  for (let i = 0; i < toGenerate.length; i += BATCH) {
    const batch = toGenerate.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ file, thumbPath }) => {
      // Pass existingNames so ensureThumb skips its own directory browse
      const url = await ensureThumb(file, thumbPath, false, existingNames);
      onFileReady(file, url);
    }));
  }
}

/**
 * Given a list of image paths and a thumb mode, return a Map of
 *   original path → URL to display  (thumb URL or original URL).
 * Backed by resolveDisplayUrlsProgressive for efficient directory access.
 *
 * @param {string[]} files
 * @param {string}   thumbMode  — THUMB_MODES value
 * @returns {Promise<Map<string,string>>}
 */
export async function resolveDisplayUrls(files, thumbMode) {
  const map = new Map();
  await resolveDisplayUrlsProgressive(files, thumbMode, (f, url) => map.set(f, url));
  return map;
}

/**
 * Decide whether to use thumbnails based on count and mode.
 * Exported so callers (ui-window, ui-hud) can choose between the progressive
 * thumb path and the IntersectionObserver lazy path before calling renderImageGrid.
 * @param {number} count
 * @param {string} mode
 * @returns {boolean}
 */
export function shouldUseThumb(count, mode) {
  if (mode === THUMB_MODES.FORCE) return true;
  if (mode === THUMB_MODES.LAZY)  return false;
  return count < THUMB_AUTO_THRESHOLD;  // AUTO
}

/**
 * Derive the thumbnail storage path for a source file. Uses a simple hash of the source path to avoid collisions.
 * @param {string} sourceFile
 * @param {string} storageRoot
 * @returns {string}
 */
export function thumbPathFor(sourceFile, storageRoot) {
  const hash = simpleHash(sourceFile);
  const ext  = isVideo(sourceFile) ? 'webp' : 'webp';
  return `${storageRoot}/${hash}.${ext}`;
}

async function ensureDirectory(dirPath) {
  const parts    = dirPath.split('/').filter(Boolean);
  let   building = '';
  for (const part of parts) {
    building = building ? `${building}/${part}` : part;
    try {
      await FilePicker.createDirectory('data', building);
    } catch (e) {
      // Foundry throws if the directory already exists
      if (!e?.message?.includes('already exists') &&
          !e?.message?.includes('EEXIST')) {
        throw e;
      }
    }
  }
}

/**
 * Ensure a thumbnail exists for the given source file.
 *
 * @param {string}      sourcePath
 * @param {string}      thumbPath
 * @param {boolean}     [force=false]         — always regenerate even if the thumbnail exists
 * @param {Set<string>} [existingNames=null]  — pre-built set of filenames already in thumbDir;
 *                                              when provided, skips the FilePicker.browse check
 * @returns {Promise<string>}  the thumb path on success, or sourcePath as fallback
 */
export async function ensureThumb(sourcePath, thumbPath, force = false, existingNames = null) {
  const thumbDir  = thumbPath.substring(0, thumbPath.lastIndexOf('/'));
  const thumbName = thumbPath.split('/').pop();

  let exists = false;
  if (existingNames !== null) {
    // Fast path: use the pre-built set, avoid a FilePicker.browse round-trip
    exists = existingNames.has(thumbName);
  } else {
    try {
      const result = await FilePicker.browse('data', thumbDir);
      exists = (result.files ?? []).some(f => f.split('/').pop() === thumbName);
    } catch { /* directory doesn't exist yet — fall through to generation */ }
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

/**
 * Render the image (or first frame of a video) onto a canvas and export
 * @param {string} src
 * @returns {Promise<Blob|null>}
 */
async function generateThumbBlob(src) {
  return new Promise(resolve => {
    const isVid = isVideo(src);
    const el    = isVid ? document.createElement('video') : document.createElement('img');

    el.crossOrigin = 'anonymous';

    const draw = () => {
      try {
        const thumbSize = getSetting(SETTINGS.THUMB_SIZE);
        const canvas = document.createElement('canvas');
        canvas.width  = thumbSize;
        canvas.height = thumbSize;
        const ctx    = canvas.getContext('2d');
        const sw     = isVid ? el.videoWidth  : el.naturalWidth;
        const sh     = isVid ? el.videoHeight : el.naturalHeight;
        const side   = Math.min(sw, sh);
        const ox     = (sw - side) / 2;
        const oy     = (sh - side) / 2;
        ctx.drawImage(el, ox, oy, side, side, 0, 0, thumbSize, thumbSize);
        canvas.toBlob(blob => resolve(blob), 'image/webp', 0.85);
      } catch { resolve(null); }
    };

    if (isVid) {
      el.preload  = 'metadata';
      el.muted    = true;
      el.src      = src;
      // After metadata loads, seek past the first frame to avoid blank frames
      el.addEventListener('loadedmetadata', () => {
        el.currentTime = Math.min(0.1, (el.duration || 1) * 0.1);
      }, { once: true });
      el.addEventListener('seeked', draw, { once: true });
      el.addEventListener('error', () => resolve(null), { once: true });
      el.load();
    } else {
      el.addEventListener('load',  draw, { once: true });
      el.addEventListener('error', () => resolve(null), { once: true });
      el.src = src;
    }
  });
}

// ── Utilities ────────────────────────────────────────────────────────────────

/** Very fast non-cryptographic string hash → hex string */
function simpleHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** True if the file extension is a video format */
export function isVideo(path) {
  return /\.(webm|mp4|ogg)$/i.test(path);
}

// ── Filename metadata parsing ─────────────────────────────────────────────────

/**
 * Ordered list of metadata keys recognised in filenames.
 * @type {readonly string[]}
 */
const FILENAME_META_KEYS = Object.freeze(['name', 'size', 'scale']);

/**
 * Parse metadata encoded in a filename using the `_key_value_` convention.
 * Handles URL-encoded characters (like %20 for spaces) and prevents 
 * trailing variant numbers (like _01) from being captured into values.
 *
 * @param {string} filepath
 * @returns {{ name?: string, size?: string, scale?: string }}
 */
export function parseFilenameMetadata(filepath) {
  if (!filepath) return {};

  let filename = filepath.split('/').pop();

  try {
    filename = decodeURIComponent(filename);
  } catch (e) {
    // If decoding fails due to a malformed path, we proceed with the raw name
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
    
    let valueEnd = stem.indexOf('_', valueStart);
    if (valueEnd === -1) {
      valueEnd = stem.length;
    }

    const value = stem.slice(valueStart, valueEnd).trim();
    if (value) meta[key] = value;
  }

  return meta;
}