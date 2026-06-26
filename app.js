import { encryptContent, decryptContent } from './lib/crypto.js';
import { reflowTable, getPipePositions, getCellContentStart } from './lib/format.js';
import {
  escHtml,
  getUrlParam,
  setUrlParams,
  clearUrlPath,
  escAttr,
  formatDate,
  arrayToBase64,
  commitMsg,
  highlightCode,
} from './lib/util.js';

// ============= STATE =============
let cm = null;
let taskIdx = 0;

function getContent() {
  return cm ? cm.getValue() : document.getElementById('editorContent')?.value || '';
}
function setContent(val) {
  if (cm) {
    cm.setValue(val);
    cm.clearHistory();
  } else {
    document.getElementById('editorContent').value = val;
  }
}

let state = {
  config: {},
  notes: [],
  dirs: [],
  currentBrowsePath: '',
  currentFile: null,
  currentContent: '',
  originalContent: '',
  isDirty: false,
  showPreview: false,
  connected: false,
};

// ============= CONFIG =============
function loadConfig() {
  try {
    const saved = localStorage.getItem('memoweb_config');
    if (saved) state = { ...state, config: JSON.parse(saved) };
  } catch {}
  const owner = getUrlParam('owner');
  const repo = getUrlParam('repo');
  const branch = getUrlParam('branch');
  if (owner || repo || branch) {
    state = {
      ...state,
      config: {
        ...state.config,
        ...(owner && { ghOwner: owner }),
        ...(repo && { ghRepo: repo }),
        ...(branch && { ghBranch: branch }),
      },
    };
  }
  applyConfigToUI();
}
function applyConfigToUI() {
  const c = state.config;
  document.getElementById('ghToken').value = c.ghToken || '';
  document.getElementById('ghOwner').value = c.ghOwner || '';
  document.getElementById('ghRepo').value = c.ghRepo || '';
  document.getElementById('ghBranch').value = c.ghBranch || 'main';
  document.getElementById('ghPath').value = c.ghPath || '';
  document.getElementById('fileExt').value = c.fileExt || '.md.gpg';
  document.getElementById('cryptoMode').value = c.cryptoMode || 'key';
  document.getElementById('publicKey').value = c.publicKey || '';
  document.getElementById('privateKey').value = c.privateKey || '';
  document.getElementById('keyPassphrase').value = c.keyPassphrase || '';
  document.getElementById('cryptoPassword').value = c.cryptoPassword || '';
  onCryptoModeChange();
}
function saveConfigToState() {
  state = {
    ...state,
    config: {
      ...state.config,
      ghToken: document.getElementById('ghToken').value.trim(),
      ghOwner: document.getElementById('ghOwner').value.trim(),
      ghRepo: document.getElementById('ghRepo').value.trim(),
      ghBranch: document.getElementById('ghBranch').value.trim() || 'main',
      ghPath: document.getElementById('ghPath').value.trim(),
      fileExt: document.getElementById('fileExt').value.trim() || '.md.gpg',
      cryptoMode: document.getElementById('cryptoMode').value,
      publicKey: document.getElementById('publicKey').value.trim(),
      privateKey: document.getElementById('privateKey').value.trim(),
      keyPassphrase: document.getElementById('keyPassphrase').value,
      cryptoPassword: document.getElementById('cryptoPassword').value,
    },
  };
}

function onCryptoModeChange() {
  const mode = document.getElementById('cryptoMode').value;
  document.getElementById('keyMode').style.display = mode === 'key' ? 'block' : 'none';
  document.getElementById('passwordMode').style.display = mode === 'password' ? 'block' : 'none';
}

// ============= SETTINGS MODAL =============
function openSettings() {
  document.getElementById('settingsModal').classList.add('open');
}
function closeSettings() {
  document.getElementById('settingsModal').classList.remove('open');
}
function switchTab(tabId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === tabId));
}

async function saveSettings() {
  saveConfigToState();
  try {
    localStorage.setItem('memoweb_config', JSON.stringify(state.config));
  } catch (e) {
    console.warn('localStorage write failed:', e);
  }
  closeSettings();
  await connect();
}

async function verifyRepo() {
  const c = state.config;
  try {
    const res = await fetch(`https://api.github.com/repos/${c.ghOwner}/${c.ghRepo}`, {
      headers: {
        Authorization: `Bearer ${c.ghToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'MemoWeb',
      },
    });
    if (res.status === 404) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Repository ${c.ghOwner}/${c.ghRepo} not found or no access. ${err.message || ''}`);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub API error: ${res.status}`);
    }
    return await res.json();
  } catch (e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      throw new Error('Cannot reach GitHub API. Are you offline or behind a firewall?');
    }
    throw e;
  }
}

// ============= GITHUB API =============
async function gh(method, path, body) {
  const c = state.config;
  const url = `https://api.github.com${path}`;
  const headers = {
    Authorization: `Bearer ${c.ghToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'MemoWeb',
  };
  const opts = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.message || `GitHub API error ${res.status}`;
    console.error('GitHub API error:', res.status, err);
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function ghGetFile(path) {
  const c = state.config;
  const ref = c.ghBranch || 'main';
  const encoded = encodeURIComponent(path);
  try {
    return await gh('GET', `/repos/${c.ghOwner}/${c.ghRepo}/contents/${encoded}?ref=${ref}`);
  } catch (e) {
    if (e.message.includes('Not Found') || e.message.includes('404')) return null;
    throw e;
  }
}

async function ghListDir(path) {
  const c = state.config;
  const ref = c.ghBranch || 'main';
  const encoded = encodeURIComponent(path);
  try {
    return await gh('GET', `/repos/${c.ghOwner}/${c.ghRepo}/contents/${encoded}?ref=${ref}`);
  } catch (e) {
    if (e.message.includes('Not Found') || e.message.includes('404')) return [];
    throw e;
  }
}

async function ghPutFile(path, content, message, sha) {
  const c = state.config;
  const encoded = encodeURIComponent(path);
  const body = {
    message,
    content: typeof content === 'string' ? btoa(content) : arrayToBase64(content),
    branch: c.ghBranch || 'main',
  };
  if (sha) body.sha = sha;
  return await gh('PUT', `/repos/${c.ghOwner}/${c.ghRepo}/contents/${encoded}`, body);
}

async function ghDeleteFile(path, sha, message) {
  const c = state.config;
  const encoded = encodeURIComponent(path);
  return await gh('DELETE', `/repos/${c.ghOwner}/${c.ghRepo}/contents/${encoded}`, {
    message: message || `Delete ${path}`,
    sha,
    branch: c.ghBranch || 'main',
  });
}

// ============= CRYPTO =============

// ============= CONNECT & LIST =============
async function connect() {
  const c = state.config;
  if (!c.ghToken || !c.ghOwner || !c.ghRepo) {
    setConnectionStatus('Configure settings first', false);
    return;
  }

  setConnectionStatus('Connecting...', false);
  state = { ...state, notes: [], dirs: [] };
  renderNoteList();

  try {
    const path = c.ghPath || '';
    const ext = c.fileExt || '.md.gpg';
    console.log('Connecting to', `${c.ghOwner}/${c.ghRepo}`, 'path:', path, 'branch:', c.ghBranch);

    // Verify repo exists and is accessible
    const repoData = await verifyRepo();
    console.log('Repo found:', repoData.full_name, 'default branch:', repoData.default_branch);
    document.getElementById('sidebarTitle').textContent = repoData.name;

    // Use the repo's default branch if user didn't specify one
    if (!c.ghBranch || c.ghBranch === 'main') {
      const branch = repoData.default_branch || 'main';
      if (state.config.ghBranch !== branch) {
        state = { ...state, config: { ...state.config, ghBranch: branch } };
      }
    }

    const entries = path ? await ghListDir(path) : await ghListDir('');

    if (!Array.isArray(entries)) {
      console.warn('Unexpected response from GitHub API, expected array, got:', entries);
      setConnectionStatus('Connected', true);
      renderNoteList();
      document.getElementById('newNoteBtn').disabled = false;
      return;
    }

    state = {
      ...state,
      dirs: entries
        .filter(item => item.type === 'dir')
        .map(item => ({
          name: item.name,
          path: item.path,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };

    state = {
      ...state,
      notes: entries
        .filter(item => item.type === 'file' && item.name.endsWith(ext))
        .map(item => ({
          name: item.name,
          path: item.path,
          sha: item.sha,
          size: item.size,
          date: item.last_modified || '',
          dirty: false,
          content: null,
          decrypted: null,
          originalText: '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };

    state = { ...state, currentBrowsePath: path };

    const total = state.notes.length;
    const dirCount = state.dirs.length;
    setConnectionStatus(`Connected · ${total} notes${dirCount ? ` · ${dirCount} folders` : ''}`, true);
    renderNoteList();
    document.getElementById('newNoteBtn').disabled = false;

    if (state.currentFile) {
      const stillExists = state.notes.find(n => n.path === state.currentFile.path);
      if (!stillExists) {
        closeEditor();
      }
    }
  } catch (e) {
    console.error('Connection error:', e);
    setConnectionStatus(`Error: ${e.message}`, false);
    toast(e.message, 'error');
  }
}

async function pullChanges() {
  const c = state.config;
  if (!c.ghToken) {
    toast('Configure settings first', 'error');
    return;
  }

  if (state.currentFile && state.isDirty) {
    if (!confirm('Discard unsaved changes?')) return;
  }

  const currentPath = state.currentBrowsePath;
  const ext = c.fileExt || '.md.gpg';

  setConnectionStatus('Syncing...', state.connected);

  try {
    const entries = await ghListDir(currentPath || '');
    if (Array.isArray(entries)) {
      state = {
        ...state,
        dirs: entries
          .filter(i => i.type === 'dir')
          .map(i => ({ name: i.name, path: i.path }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
      state = {
        ...state,
        notes: entries
          .filter(i => i.type === 'file' && i.name.endsWith(ext))
          .map(i => ({
            name: i.name,
            path: i.path,
            sha: i.sha,
            size: i.size,
            date: i.last_modified || '',
            dirty: false,
            content: null,
            decrypted: null,
            originalText: '',
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
      renderNoteList();
    }

    const openFile = state.currentFile;
    if (openFile) {
      const stillExists = state.notes.find(n => n.path === openFile.path);
      if (stillExists) {
        const data = await ghGetFile(openFile.path);
        if (data) {
          const binary = Uint8Array.from(atob(data.content), c => c.charCodeAt(0));
          const decrypted = await decryptContent(state.config, binary);
          const updatedNote = { ...openFile, sha: data.sha, content: data.content, decrypted, dirty: false };
          state = {
            ...state,
            notes: state.notes.map(n => n.path === openFile.path ? updatedNote : n),
            currentFile: updatedNote,
            originalContent: decrypted,
            currentContent: decrypted,
            isDirty: false,
          };
          setContent(decrypted);
          updatePreview();
        }
      } else {
        closeEditor();
        toast('Current note was deleted on remote', 'info');
      }
    }

    const total = state.notes.length;
    const dirCount = state.dirs.length;
    setConnectionStatus(`Synced · ${total} notes${dirCount ? ` · ${dirCount} folders` : ''}`, true);
    renderNoteList();
    toast('Synced with remote', 'info');
  } catch (e) {
    setConnectionStatus('Sync failed', state.connected);
    toast(`Sync failed: ${e.message}`, 'error');
  }
}

function setConnectionStatus(text, connected) {
  state = { ...state, connected };
  const el = document.getElementById('connectionStatus');
  const icon = connected ? '🟢' : text.startsWith('Error') ? '🔴' : text.includes('Connect') ? '🟡' : '⚪';
  el.innerHTML = `<span>${icon}</span><span class="label"> ${escHtml(text)}</span>`;
  el.style.color = connected ? 'var(--green)' : text.startsWith('Error') ? 'var(--red)' : 'var(--text-muted)';
  const ps = document.getElementById('placeholderStatus');
  if (ps) ps.textContent = text;
}

function renderBreadcrumb() {
  const el = document.getElementById('breadcrumb');
  const current = state.currentBrowsePath;
  const parts = current ? current.split('/').filter(Boolean) : [];
  if (parts.length === 0) {
    el.textContent = current ? '/' : '';
    return;
  }
  let html = '';
  let accumulated = '';
  for (let i = 0; i < parts.length; i++) {
    accumulated = accumulated ? accumulated + '/' + parts[i] : parts[i];
    const label = escHtml(parts[i]);
    if (i === parts.length - 1) {
      html += `<span style="color:var(--text);font-weight:500;">${label}</span>`;
    } else {
      html += `<a href="#" onclick="event.preventDefault();navigateToDir('${escAttr(accumulated)}')" style="color:var(--accent)">${label}</a><span style="color:var(--text-muted);margin:0 4px;">/</span>`;
    }
  }
  el.innerHTML = html;
}

// ============= RENDER NOTE LIST =============
function renderNoteList() {
  const list = document.getElementById('noteList');
  renderBreadcrumb();

  if (state.dirs.length === 0 && state.notes.length === 0) {
    const msg = state.connected ? 'Empty directory' : 'Configure your repo in settings to get started';
    list.innerHTML = `<div class="empty-state"><div class="icon">📁</div><p>${msg}</p></div>`;
    return;
  }
  const items = [];

  // Parent directory link (when not at root)
  if (state.currentBrowsePath) {
    const parent = state.currentBrowsePath.split('/').slice(0, -1).join('/') || '';
    items.push(`<div class="note-item" data-path="${escAttr(parent)}" data-type="dir">
      <span class="name" style="color:var(--text-muted)">🔙 ..</span>
      <span style="font-size:11px;color:var(--text-muted)">parent</span>
    </div>`);
  }

  // Directories first
  state.dirs.forEach(d => {
    items.push(`<div class="note-item" data-path="${escAttr(d.path)}" data-type="dir">
      <span class="name" style="color:var(--accent)">📁 ${escHtml(d.name)}</span>
      <span style="font-size:11px;color:var(--text-muted)">folder</span>
    </div>`);
  });

  // Then files
  state.notes.forEach(n => {
    const active = state.currentFile && state.currentFile.path === n.path;
    const name = n.name.replace(/\.md\.gpg$/, '').replace(/\.gpg$/, '');
    items.push(`<div class="note-item ${active ? 'active' : ''}" data-path="${escAttr(n.path)}" data-type="file">
      <span class="name">📄 ${escHtml(name)}</span>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        ${n.dirty ? '<span class="status-badge dirty">unsaved</span>' : ''}
        <span class="date">${n.date ? escHtml(formatDate(n.date)) : ''}</span>
      </div>
    </div>`);
  });

  list.innerHTML = items.join('');
}

function toggleTaskByIndex(idx) {
  const content = cm ? cm.getValue() : document.getElementById('editorContent').value;
  const lines = content.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*[-*+]\s+)\[([ x])\]\s*/);
    if (m) {
      if (count === idx) {
        const newCheck = m[2] === 'x' ? ' ' : 'x';
        const newLine = lines[i].replace(/(\[)[ x](\])/, '$1' + newCheck + '$2');
        if (cm) {
          cm.replaceRange(newLine, { line: i, ch: 0 }, { line: i, ch: lines[i].length });
        } else {
          const ta = document.getElementById('editorContent');
          ta.value = content.replace(lines[i], newLine);
          ta.dispatchEvent(new Event('input'));
        }
        onEditorInput();
        return;
      }
      count++;
    }
  }
}

function formatTable(c, insertLine) {
  const lines = c.getValue().split('\n'),
    n = lines.length;
  let start = insertLine;
  while (start > 0 && lines[start - 1] && lines[start - 1][0] === '|') start--;
  let end = insertLine;
  while (end < n - 1 && lines[end + 1] && lines[end + 1][0] === '|') end++;
  const rowLines = [],
    rowParts = [];
  let cols = 0;
  for (let i = start; i <= end; i++) {
    if (!lines[i] || lines[i][0] !== '|') continue;
    const parts = lines[i].split('|');
    parts.shift();
    parts.pop();
    rowLines.push(i);
    rowParts.push(parts);
    if (parts.length > cols) cols = parts.length;
  }
  if (cols < 2) {
    c.replaceRange('\n', { line: insertLine, ch: 0 });
    c.setCursor({ line: insertLine + 1, ch: 0 });
    return;
  }
  const widths = reflowTable(lines, rowLines, rowParts, cols);
  // Build empty row with matching widths
  let newRow = '|';
  for (let j = 0; j < cols; j++) newRow += ' ' + Array(widths[j] + 2).join(' ') + '|';
  const anchor = rowLines[rowLines.length - 1];
  lines.splice(anchor + 1, 0, newRow);
  c.setValue(lines.join('\n'));
  c.setCursor({ line: anchor + 1, ch: 1 });
  onEditorInput();
}

function formatDoc() {
  if (!cm || !state.currentFile) return;
  if (typeof prettier === 'undefined' || !window.prettierPlugins) {
    // Lazy-load Prettier
    const s1 = document.createElement('script');
    s1.src = 'https://cdn.jsdelivr.net/npm/prettier@3/standalone.js';
    s1.onload = function () {
      const s2 = document.createElement('script');
      s2.src = 'https://cdn.jsdelivr.net/npm/prettier@3/plugins/markdown.js';
      s2.onload = formatDoc;
      document.head.appendChild(s2);
    };
    document.head.appendChild(s1);
    return;
  }
  const text = cm.getValue(),
    cursor = cm.getCursor();
  Promise.resolve(prettier.format(text, { parser: 'markdown', plugins: [window.prettierPlugins.markdown] })).then(
    function (formatted) {
      cm.setValue(formatted);
      cm.setCursor(cursor);
      onEditorInput();
    },
  );
}

function smartEnter(c) {
  const cursor = c.getCursor(),
    line = c.getLine(cursor.line);
  // Table row: format table, then continue
  if (line[0] === '|' && line.split('|').length >= 4 && cursor.ch >= line.indexOf('|')) {
    formatTable(c, cursor.line + 1);
    return;
  }
  let m = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ x]\]\s+)?)/);
  if (!m || cursor.ch < m[1].length) return CodeMirror.Pass;
  const rest = line.slice(m[1].length);
  if (!rest.trim()) {
    c.replaceRange('', { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
  } else {
    let prefix = m[1];
    m = prefix.match(/^(\s*)(\d+)([.)])/);
    if (m) prefix = m[1] + (parseInt(m[2], 10) + 1) + m[3] + ' ';
    c.replaceRange('\n' + prefix, { line: cursor.line, ch: cursor.ch });
  }
  onEditorInput();
}

function handleTab(c) {
  if (moveInTable(c, false)) return;
  c.execCommand('insertSoftTab');
}
function handleShiftTab(c) {
  if (moveInTable(c, true)) return;
  return CodeMirror.Pass;
}
function moveInTable(c, shift) {
  const cur = c.getCursor(),
    line = c.getLine(cur.line);
  if (!line.match(/^\|/) || line.split('|').length < 3) return false;
  const pipes = getPipePositions(line);
  let cell = -1;
  for (let i = 0; i < pipes.length - 1; i++) {
    if (cur.ch >= pipes[i] && cur.ch < pipes[i + 1]) {
      cell = i;
      break;
    }
  }
  if (cell < 0) return false;
  const target = shift ? cell - 1 : cell + 1;
  if (target < 0 || target >= pipes.length - 1) return false;
  const pos = getCellContentStart(line, pipes[target]);
  if (pos < 0) return false;
  c.setCursor({ line: cur.line, ch: pos });
  return true;
}

function toggleTaskOnLine() {
  if (!cm || !state.currentFile) return;
  const cursor = cm.getCursor();
  const line = cm.getLine(cursor.line);
  const m = line.match(/^(\s*[-*+]\s+)\[([ x])\]\s*/);
  if (m) {
    const newCheck = m[2] === 'x' ? ' ' : 'x';
    const newLine = line.replace(/(\[)[ x](\])/, '$1' + newCheck + '$2');
    cm.replaceRange(newLine, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
    onEditorInput();
  } else {
    cm.replaceRange('- [ ] ', { line: cursor.line, ch: 0 });
    cm.setCursor({ line: cursor.line, ch: 6 });
    onEditorInput();
  }
}

async function openNoteByPath(path) {
  let note = state.notes.find(n => n.path === path);
  if (note) {
    selectNote(path);
    return;
  }
  const parts = path.split('/');
  if (parts.length > 1) {
    const dir = parts.slice(0, -1).join('/');
    try {
      await navigateToDir(dir);
      note = state.notes.find(n => n.path === path);
      if (note) selectNote(path);
    } catch (e) {
      toast(`Could not open note: ${e.message}`, 'error');
    }
  }
}

async function navigateToDir(dirPath) {
  if (state.currentFile && state.isDirty) {
    if (!confirm('Discard unsaved changes?')) return;
    closeEditor();
  }

  setConnectionStatus('Loading...', state.connected);
  const c = state.config;

  try {
    const entries = await ghListDir(dirPath || '');
    if (!Array.isArray(entries)) {
      setConnectionStatus('Connected', true);
      return;
    }

    const ext = c.fileExt || '.md.gpg';
    state = {
      ...state,
      dirs: entries
        .filter(item => item.type === 'dir')
        .map(item => ({ name: item.name, path: item.path }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };

    state = {
      ...state,
      notes: entries
        .filter(item => item.type === 'file' && item.name.endsWith(ext))
        .map(item => ({
          name: item.name,
          path: item.path,
          sha: item.sha,
          size: item.size,
          date: item.last_modified || '',
          dirty: false,
          content: null,
          decrypted: null,
          originalText: '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };

    state = { ...state, currentBrowsePath: dirPath, currentFile: null, isDirty: false };
    closeEditor();

    const total = state.notes.length;
    const dirCount = state.dirs.length;
    setConnectionStatus(`Connected · ${total} notes${dirCount ? ` · ${dirCount} folders` : ''}`, true);
    renderNoteList();
  } catch (e) {
    console.error('Directory navigation error:', e);
    toast(e.message, 'error');
  }
}

// ============= NOTE SELECTION =============
async function selectNote(path) {
  let note = state.notes.find(n => n.path === path);
  if (!note) return;

  // If switching away from dirty note, warn but proceed
  if (state.currentFile && state.isDirty) {
    if (!confirm('Discard unsaved changes?')) return;
  }

  setUrlParams({ path: note.path });
  state = { ...state, currentFile: note, isDirty: false };
  renderNoteList();

  document.getElementById('placeholder').style.display = 'none';
  document.getElementById('editor').style.display = 'flex';
  document.getElementById('editorFilename').textContent = note.name;
  document.getElementById('editorStatus').textContent = 'Decrypting...';
  state = { ...state, originalContent: '' };
  setContent('');
  document.getElementById('saveBtn').disabled = true;
  document.getElementById('deleteBtn').disabled = true;

  try {
    // Fetch from GitHub if not cached
    if (!note.content) {
      const data = await ghGetFile(note.path);
      if (!data) throw new Error('File not found');
      const updatedNote = { ...note, content: data.content, sha: data.sha };
      state = {
        ...state,
        notes: state.notes.map(n => n.path === note.path ? updatedNote : n),
        currentFile: updatedNote,
      };
      note = updatedNote;
    }

    const binary = Uint8Array.from(atob(note.content), c => c.charCodeAt(0));
    const decrypted = await decryptContent(state.config, binary);
    const updatedNote = { ...note, decrypted, originalText: decrypted };
    state = {
      ...state,
      notes: state.notes.map(n => n.path === note.path ? updatedNote : n),
      currentFile: updatedNote,
      originalContent: decrypted,
      currentContent: decrypted,
      isDirty: false,
    };
    setContent(decrypted);
    document.getElementById('editorStatus').textContent = '';
    document.getElementById('saveBtn').disabled = false;
    document.getElementById('deleteBtn').disabled = false;

    updatePreview();
  } catch (e) {
    document.getElementById('editorStatus').textContent = `❌ ${e.message}`;
    toast(`Failed to decrypt: ${e.message}`, 'error');
  }
}

function closeEditor() {
  state = { ...state, currentFile: null, isDirty: false };
  clearUrlPath();
  document.getElementById('placeholder').style.display = 'flex';
  document.getElementById('editor').style.display = 'none';
  renderNoteList();
}

// ============= EDITOR =============
document.addEventListener('DOMContentLoaded', () => {
  // Init CodeMirror
  const ta = document.getElementById('editorContent');
  if (typeof CodeMirror !== 'undefined') {
    // Register short language names for fenced code block highlighting
    CodeMirror.defineMIME('json', 'javascript');
    CodeMirror.defineMIME('js', 'javascript');
    CodeMirror.defineMIME('py', 'python');
    CodeMirror.defineMIME('sh', 'shell');
    CodeMirror.defineMIME('bash', 'shell');
    CodeMirror.defineMIME('shell', 'shell');
    CodeMirror.defineMIME('yaml', 'yaml');
    CodeMirror.defineMIME('yml', 'yaml');
    CodeMirror.defineMIME('css', 'css');
    CodeMirror.defineMIME('xml', 'xml');
    CodeMirror.defineMIME('html', 'htmlmixed');
    CodeMirror.defineMIME('sql', 'sql');
    CodeMirror.defineMIME('lua', 'lua');
    cm = CodeMirror.fromTextArea(ta, {
      mode: { name: 'markdown', highlightFormatting: true, fencedCodeBlockHighlighting: true },
      theme: 'material-darker',
      lineNumbers: false,
      lineWrapping: true,
      indentUnit: 2,
      tabSize: 2,
      viewportMargin: Infinity,
      matchBrackets: true,
      extraKeys: { Tab: handleTab, 'Shift-Tab': handleShiftTab, 'Ctrl-Enter': toggleTaskOnLine, Enter: smartEnter },
    });
    cm.on('change', onEditorInput);
  } else {
    ta.addEventListener('input', onEditorInput);
  }

  // Refresh CodeMirror when editor shown (fixes layout)
  const observer = new MutationObserver(() => {
    if (cm) setTimeout(() => cm.refresh(), 50);
  });
  observer.observe(document.getElementById('editor'), { attributes: true, attributeFilter: ['style'] });

  // Event delegation for note/dir list clicks
  document.getElementById('noteList').addEventListener('click', e => {
    const item = e.target.closest('.note-item');
    if (!item) return;
    if (item.dataset.type === 'dir') {
      navigateToDir(item.dataset.path);
    } else {
      selectNote(item.dataset.path);
    }
  });
  // Keyboard shortcut: Ctrl/Cmd + S to save
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (state.currentFile) saveNote();
    }
  });
});

function onEditorInput() {
  const newContent = getContent();
  const dirty = newContent !== state.originalContent;
  const updatedFile = state.currentFile ? { ...state.currentFile, dirty } : null;
  state = {
    ...state,
    currentContent: newContent,
    isDirty: dirty,
    currentFile: updatedFile,
    notes: state.currentFile
      ? state.notes.map(n => n.path === state.currentFile.path ? updatedFile : n)
      : state.notes,
  };
  if (dirty) {
    renderNoteList();
    document.getElementById('editorStatus').textContent = '📝 Unsaved changes';
    document.getElementById('discardBtn').style.display = '';
  } else {
    document.getElementById('editorStatus').textContent = '';
    document.getElementById('discardBtn').style.display = 'none';
  }
  if (state.showPreview) updatePreview();
}

function togglePreview() {
  state = { ...state, showPreview: !state.showPreview };
  document.getElementById('previewContainer').style.display = state.showPreview ? 'flex' : 'none';
  document.getElementById('previewToggle').textContent = state.showPreview ? '✕ Preview' : '👁️ Preview';
  if (state.showPreview) updatePreview();
}

function updatePreview() {
  const preview = document.getElementById('previewPane');
  const text = getContent();
  preview.innerHTML = renderMarkdown(text);
}

function renderMarkdown(text) {
  if (!window.marked) return escHtml(text);
  taskIdx = 0;
  return marked.parse(text, { breaks: true, gfm: true });
}

if (window.marked) {
  marked.use({
    renderer: {
      code({ text, lang }) {
        const highlighted = highlightCode(text, lang || '', window.hljs);
        return `<pre><code class="language-${escAttr(lang || 'plaintext')}">${highlighted}</code></pre>`;
      },
      listitem({ text, task, checked }) {
        if (task) {
          const idx = taskIdx++;
          return `<li style="list-style:none;"><input type="checkbox" ${checked ? 'checked' : ''} data-task="${idx}" onclick="toggleTaskByIndex(${idx})"> ${text}</li>`;
        }
        return `<li>${text}</li>`;
      },
    },
  });
}

function insertMarkdown(before, after) {
  if (cm) {
    const selected = cm.getSelection();
    const from = cm.getCursor('from');
    cm.replaceSelection(before + selected + after);
    if (!selected) {
      cm.setCursor({ line: from.line, ch: from.ch + before.length });
    }
    cm.focus();
    onEditorInput();
    return;
  }
  const ta = document.getElementById('editorContent');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const text = ta.value;
  const selected = text.substring(start, end);
  ta.value = text.substring(0, start) + before + selected + after + text.substring(end);
  ta.selectionStart = start + before.length;
  ta.selectionEnd = start + before.length + selected.length;
  ta.focus();
  onEditorInput();
}

function discardChanges() {
  const note = state.currentFile;
  if (!note) return;

  if (!note.sha) {
    // New unsaved note — remove from sidebar and close
    if (!confirm('Discard this new note?')) return;
    state = { ...state, notes: state.notes.filter(n => n.path !== note.path) };
    closeEditor();
    renderNoteList();
    toast('Note discarded', 'info');
    return;
  }

  // Existing note — revert to last saved content
  const text = note.originalText || '';
  const updatedNote = { ...note, dirty: false, decrypted: text };
  state = {
    ...state,
    originalContent: text,
    currentContent: text,
    isDirty: false,
    currentFile: updatedNote,
    notes: state.notes.map(n => n.path === note.path ? updatedNote : n),
  };

  setContent(text);
  document.getElementById('editorStatus').textContent = '';
  document.getElementById('discardBtn').style.display = 'none';
  updatePreview();
  renderNoteList();
  toast('Changes discarded', 'info');
}

// ============= SAVE / DELETE =============
async function saveNote() {
  if (!state.currentFile) return;
  const text = getContent();
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Saving...';

  try {
    const encrypted = await encryptContent(state.config, text);
    const note = state.currentFile;
    const b64 = typeof encrypted === 'string' ? btoa(encrypted) : arrayToBase64(encrypted);

    const result = await ghPutFile(note.path, encrypted, commitMsg(), note.sha);
    const updatedNote = { ...note, sha: result.content.sha, content: b64, decrypted: text, originalText: text, dirty: false };
    state = {
      ...state,
      notes: state.notes.map(n => n.path === note.path ? updatedNote : n),
      currentFile: updatedNote,
      originalContent: text,
      isDirty: false,
    };

    document.getElementById('editorStatus').textContent = '✅ Saved';
    toast('Note saved successfully', 'success');
    renderNoteList();
  } catch (e) {
    const isConflict =
      e.message.includes('does not match') || e.message.includes('409') || e.message.toLowerCase().includes('conflict');
    toast(
      isConflict ? `⛔ Remote file changed — click 🔄 Sync to refresh, then save again` : `Save failed: ${e.message}`,
      'error',
    );
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Save';
  }
}

async function newNote() {
  if (state.currentFile && state.isDirty) {
    if (!confirm('Discard unsaved changes?')) return;
  }

  const name = prompt('Note name (e.g., my-note):');
  if (!name || !name.trim()) return;

  const ext = state.config.fileExt || '.md.gpg';
  const dir = state.currentBrowsePath || state.config.ghPath || '';
  const path = dir ? `${dir}/${name.trim()}${ext}` : `${name.trim()}${ext}`;

  // Check if exists
  const existing = await ghGetFile(path);
  if (existing) {
    toast('A note with this name already exists', 'error');
    return;
  }

  state = { ...state, currentFile: null, isDirty: false };

  document.getElementById('placeholder').style.display = 'none';
  document.getElementById('editor').style.display = 'flex';
  document.getElementById('editorFilename').textContent = `${name.trim()}${ext}`;
  document.getElementById('editorStatus').textContent = '🆕 New note';
  setContent(`# ${name.trim()}\n\n`);
  document.getElementById('saveBtn').disabled = false;
  document.getElementById('deleteBtn').disabled = true;
  const currentContent = getContent();
  state = { ...state, currentContent, originalContent: '', isDirty: true };

  // Create a temporary note object and add to sidebar immediately
  const newNoteObj = {
    name: `${name.trim()}${ext}`,
    path: path,
    sha: null,
    size: 0,
    date: '',
    dirty: true,
    content: null,
    decrypted: currentContent,
    originalText: '',
  };
  state = {
    ...state,
    currentFile: newNoteObj,
    notes: [...state.notes, newNoteObj].sort((a, b) => a.name.localeCompare(b.name)),
  };

  renderNoteList();
  updatePreview();
}

async function deleteNote() {
  if (!state.currentFile || !state.currentFile.sha) return;
  if (!confirm(`Delete "${state.currentFile.name}"? This cannot be undone.`)) return;

  try {
    await ghDeleteFile(state.currentFile.path, state.currentFile.sha, commitMsg());
    state = { ...state, notes: state.notes.filter(n => n.path !== state.currentFile.path) };
    closeEditor();
    toast('Note deleted', 'info');
    renderNoteList();
  } catch (e) {
    toast(`Delete failed: ${e.message}`, 'error');
  }
}

// ============= UTILITIES =============
function toast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = '0.3s';
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

function toggleTheme() {
  const root = document.documentElement;
  const isDark =
    root.style.getPropertyValue('--bg') === '#ffffff' ||
    getComputedStyle(root).getPropertyValue('--bg').trim() === '#ffffff';
  if (isDark) {
    root.style.setProperty('--bg', '#0d1117');
    root.style.setProperty('--surface', '#161b22');
    root.style.setProperty('--surface-2', '#21262d');
    root.style.setProperty('--border', '#30363d');
    root.style.setProperty('--text', '#e6edf3');
    root.style.setProperty('--text-muted', '#8b949e');
    document.getElementById('themeBtn').textContent = '🌙';
    if (cm) cm.setOption('theme', 'material-darker');
  } else {
    root.style.setProperty('--bg', '#ffffff');
    root.style.setProperty('--surface', '#f6f8fa');
    root.style.setProperty('--surface-2', '#eaeef2');
    root.style.setProperty('--border', '#d0d7de');
    root.style.setProperty('--text', '#1f2328');
    root.style.setProperty('--text-muted', '#656d76');
    document.getElementById('themeBtn').textContent = '☀️';
    if (cm) cm.setOption('theme', 'material');
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const open = sidebar.classList.toggle('open');
  overlay.classList.toggle('open', open);
}

// Keep --header-h in sync with actual header height
function syncHeaderH() {
  const h = document.querySelector('header').offsetHeight;
  document.documentElement.style.setProperty('--header-h', h + 'px');
}
window.addEventListener('load', syncHeaderH);
window.addEventListener('resize', syncHeaderH);

// Close sidebar when selecting a note on mobile
document.addEventListener('click', e => {
  const sidebar = document.getElementById('sidebar');
  if (window.innerWidth <= 768 && sidebar.classList.contains('open') && e.target.closest('.note-item')) {
    toggleSidebar();
  }
});

// ============= INIT =============
loadConfig();

async function init() {
  if (state.config.ghToken && state.config.ghOwner && state.config.ghRepo) {
    try {
      await connect();
      const path = getUrlParam('path');
      if (path) openNoteByPath(path);
    } catch (e) {
      console.error('Initial connect failed:', e);
    }
  }
}
init();

// Close modal on overlay click
document.getElementById('settingsModal').addEventListener('click', function (e) {
  if (e.target === this) closeSettings();
});
// ============= EXPOSE FOR ONCLICK =============
window.getContent = getContent;
window.setContent = setContent;
window.onCryptoModeChange = onCryptoModeChange;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.switchTab = switchTab;
window.saveSettings = saveSettings;
window.pullChanges = pullChanges;
window.renderBreadcrumb = renderBreadcrumb;
window.renderNoteList = renderNoteList;
window.toggleTaskByIndex = toggleTaskByIndex;
window.formatDoc = formatDoc;
window.handleTab = handleTab;
window.handleShiftTab = handleShiftTab;
window.toggleTaskOnLine = toggleTaskOnLine;
window.openNoteByPath = openNoteByPath;
window.navigateToDir = navigateToDir;
window.selectNote = selectNote;
window.closeEditor = closeEditor;
window.togglePreview = togglePreview;
window.insertMarkdown = insertMarkdown;
window.discardChanges = discardChanges;
window.saveNote = saveNote;
window.newNote = newNote;
window.deleteNote = deleteNote;
window.toast = toast;
window.toggleTheme = toggleTheme;
window.toggleSidebar = toggleSidebar;
