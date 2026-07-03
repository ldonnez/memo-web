export function escHtml(s) {
  if (typeof document === 'undefined') {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

export function getUrlParam(name) {
  return new URLSearchParams(window.location.search).get(name) || '';
}

export function setUrlParams(params) {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v) p.set(k, v);
    else p.delete(k);
  }
  const qs = p.toString();
  const url = window.location.pathname + (qs ? '?' + qs : '');
  window.history.replaceState(null, '', url);
}

export function clearUrlPath() {
  const p = new URLSearchParams(window.location.search);
  p.delete('path');
  const qs = p.toString();
  window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
}

export function escAttr(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatDate(s) {
  if (s == null) return '';
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(s).slice(0, 10);
    return d.toLocaleDateString();
  } catch {
    return String(s).slice(0, 10);
  }
}

export function arrayToBase64(arr) {
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

export function commitMsg(date) {
  const d = date || new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `memo-web: sync ${ts}`;
}

export function highlightCode(code, lang, hljs) {
  if (hljs && lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value;
    } catch {}
  }
  if (hljs && !lang) {
    try {
      return hljs.highlightAuto(code).value;
    } catch {}
  }
  return escHtml(code);
}

export function computeDirtyState(notes, currentFile, currentContent, originalContent) {
  const dirty = currentContent !== originalContent;
  const updatedFile = currentFile ? { ...currentFile, dirty } : null;
  return {
    currentFile: updatedFile,
    notes: currentFile ? notes.map(n => (n.path === currentFile.path ? updatedFile : n)) : notes,
    isDirty: dirty,
  };
}

export function markNoteClean(note, notes, decryptedText) {
  const text = decryptedText ?? '';
  const updated = { ...note, dirty: false, decrypted: text, originalText: text };
  return {
    currentFile: updated,
    notes: notes.map(n => (n.path === note.path ? updated : n)),
    originalContent: text,
    isDirty: false,
  };
}

export function revertNote(note, notes) {
  const text = note.originalText || '';
  const updated = { ...note, dirty: false, decrypted: text };
  return {
    currentFile: updated,
    notes: notes.map(n => (n.path === note.path ? updated : n)),
    originalContent: text,
    currentContent: text,
    isDirty: false,
  };
}

export function cleanNoteInList(notes, filePath) {
  return notes.map(n => (n.path === filePath ? { ...n, dirty: false } : n));
}

function cacheKeyForPath(path) {
  return path ? `memoweb_cache:${path}` : 'memoweb_cache:';
}

const DB_NAME = 'MemoWebCache';
const DB_VERSION = 1;
const STORE_NAME = 'cache';

function openCacheDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheNotesToLocalStorage(notes, dirs, currentBrowsePath) {
  try {
    const db = await openCacheDB();
    const key = cacheKeyForPath(currentBrowsePath);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ notes, dirs, currentBrowsePath, timestamp: Date.now() }, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch (e) {
    console.warn('Failed to cache notes:', e);
  }
}

export async function loadCachedNotes(path) {
  try {
    const db = await openCacheDB();
    const key = cacheKeyForPath(path);
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      tx.oncomplete = () => db.close();
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
    return result;
  } catch (e) {
    console.warn('Failed to load cached notes:', e);
    return null;
  }
}

export function formatNoteItem(note, activePath) {
  const active = activePath === note.path;
  const name = note.name.replace(/\.md\.gpg$/, '').replace(/\.gpg$/, '');
  const cached = !!note.content;
  return `<div class="note-item ${active ? 'active' : ''}" data-path="${escAttr(note.path)}" data-type="file">
      <span class="name">📄 ${escHtml(name)}${note.dirty ? ' *' : ''}</span>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        ${note.dirty ? '<span class="status-badge dirty">unsaved</span>' : ''}
        ${cached ? '<span class="offline-dot" title="Available offline"></span>' : ''}
        <span class="date">${note.date ? escHtml(formatDate(note.date)) : ''}</span>
      </div>
    </div>`;
}

export function findMatchRanges(text, query) {
  if (!query) return [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const len = q.length;
  const matches = [];
  let idx = 0;
  while ((idx = lower.indexOf(q, idx)) !== -1) {
    matches.push({ from: idx, to: idx + len });
    idx++;
  }
  return matches;
}
