/**
 * Picking a folder of video clips.
 *
 *  - Chrome / Edge: File System Access API (`showDirectoryPicker`) — real folder picker,
 *    walked recursively.
 *  - Everything else: a hidden <input type="file" webkitdirectory> which most browsers
 *    present as a folder chooser.
 *  - Drag & drop of a folder (or loose files) onto the page is also supported.
 *
 * Nothing is uploaded anywhere; the browser hands us File objects that we turn into
 * object URLs for <video> elements.
 */

const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv', 'ogg', 'mkv', 'avi', 'mpg', 'mpeg', '3gp', 'ts', 'mts', 'm2ts']);
const MAX_FILES = 2000;
const MAX_DEPTH = 6;

const probe = typeof document !== 'undefined' ? document.createElement('video') : null;

export function isVideoFile(file) {
  const name = file.name || '';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (name.startsWith('.')) return false;
  if (file.type && file.type.startsWith('video/')) return true;
  return VIDEO_EXTENSIONS.has(ext);
}

/**
 * Rough "can this browser probably play it" ranking: playable first, unknown next.
 * Only used for ordering — unplayable files are skipped at runtime when they error,
 * because canPlayType() is pessimistic (Chrome plays most .mov files but reports "").
 */
export function playabilityScore(file) {
  if (!probe) return 1;
  const ext = (file.name || '').split('.').pop().toLowerCase();
  if (ext === 'mov' || ext === 'mkv') return 2; // commonly playable despite canPlayType() saying no
  const mime = file.type || guessMime(file.name);
  if (!mime) return 1;
  const r = probe.canPlayType(mime);
  if (r === 'probably') return 3;
  if (r === 'maybe') return 2;
  return 0;
}

function guessMime(name = '') {
  const ext = name.split('.').pop().toLowerCase();
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mov':
      return 'video/quicktime';
    case 'ogv':
    case 'ogg':
      return 'video/ogg';
    case 'mkv':
      return 'video/x-matroska';
    case 'avi':
      return 'video/x-msvideo';
    case 'mpg':
    case 'mpeg':
      return 'video/mpeg';
    case '3gp':
      return 'video/3gpp';
    default:
      return '';
  }
}

export const supportsDirectoryPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/**
 * Open the best available folder picker.
 * @param {HTMLInputElement} legacyInput hidden <input webkitdirectory>
 * @returns {Promise<{files: File[], name: string, method: string} | null>} null if cancelled
 */
export async function pickVideoFolder(legacyInput) {
  if (supportsDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'read', id: 'rainbow-video-road' });
      const files = [];
      await walkDirectory(dir, files, 0);
      return { files: prepareVideoFiles(files), name: dir.name, method: 'fsa' };
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      // SecurityError (e.g. embedded in an iframe) → fall back to the input element
      console.warn('[folderPicker] showDirectoryPicker failed, falling back', err);
    }
  }
  return pickWithInput(legacyInput);
}

function pickWithInput(input) {
  return new Promise((resolve) => {
    const onChange = () => {
      cleanup();
      const all = Array.from(input.files || []);
      const name = all[0]?.webkitRelativePath?.split('/')[0] || 'selected files';
      input.value = '';
      resolve({ files: prepareVideoFiles(all), name, method: 'input' });
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
    };
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    input.click();
  });
}

async function walkDirectory(dir, out, depth) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  for await (const [name, handle] of dir.entries()) {
    if (out.length >= MAX_FILES) return;
    if (name.startsWith('.')) continue;
    if (handle.kind === 'file') {
      try {
        const file = await handle.getFile();
        if (isVideoFile(file)) out.push(file);
      } catch (err) {
        console.warn('[folderPicker] could not read', name, err);
      }
    } else if (handle.kind === 'directory') {
      await walkDirectory(handle, out, depth + 1);
    }
  }
}

/**
 * Collect video files from a drop event (folders are walked).
 * @param {DataTransfer} dataTransfer
 */
export async function filesFromDrop(dataTransfer) {
  const out = [];
  const items = Array.from(dataTransfer.items || []);
  let name = '';

  for (const item of items) {
    if (item.kind !== 'file') continue;
    if (typeof item.getAsFileSystemHandle === 'function') {
      try {
        const handle = await item.getAsFileSystemHandle();
        if (!handle) continue;
        if (handle.kind === 'directory') {
          name = name || handle.name;
          await walkDirectory(handle, out, 0);
        } else {
          const file = await handle.getFile();
          if (isVideoFile(file)) out.push(file);
        }
        continue;
      } catch (err) {
        console.warn('[folderPicker] getAsFileSystemHandle failed', err);
      }
    }
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) {
      if (entry.isDirectory) name = name || entry.name;
      await walkEntry(entry, out, 0);
    } else {
      const file = item.getAsFile();
      if (file && isVideoFile(file)) out.push(file);
    }
  }
  if (out.length === 0 && dataTransfer.files) {
    for (const file of Array.from(dataTransfer.files)) if (isVideoFile(file)) out.push(file);
  }
  return { files: prepareVideoFiles(out), name: name || 'dropped files', method: 'drop' };
}

function walkEntry(entry, out, depth) {
  return new Promise((resolve) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return resolve();
    if (entry.isFile) {
      entry.file(
        (file) => {
          if (isVideoFile(file)) out.push(file);
          resolve();
        },
        () => resolve(),
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(
          async (entries) => {
            if (!entries.length) return resolve();
            for (const e of entries) {
              if (e.name.startsWith('.')) continue;
              await walkEntry(e, out, depth + 1);
            }
            readBatch(); // readEntries returns in batches of ~100
          },
          () => resolve(),
        );
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

/** Filter, de-duplicate, rank by playability, and give a stable (shuffled-by-name) order. */
export function prepareVideoFiles(files) {
  const seen = new Set();
  const list = [];
  for (const f of files) {
    if (!isVideoFile(f)) continue;
    const key = `${f.name}:${f.size}:${f.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(f);
  }
  // playable first, then by name so the order is deterministic
  list.sort((a, b) => playabilityScore(b) - playabilityScore(a) || a.name.localeCompare(b.name));
  return list;
}
