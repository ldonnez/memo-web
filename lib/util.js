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

export function formatNoteItem(note, activePath) {
  const active = activePath === note.path;
  const name = note.name.replace(/\.md\.gpg$/, '').replace(/\.gpg$/, '');
  return `<div class="note-item ${active ? 'active' : ''}" data-path="${escAttr(note.path)}" data-type="file">
      <span class="name">📄 ${escHtml(name)}${note.dirty ? ' *' : ''}</span>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        ${note.dirty ? '<span class="status-badge dirty">unsaved</span>' : ''}
        <span class="date">${note.date ? escHtml(formatDate(note.date)) : ''}</span>
      </div>
    </div>`;
}
