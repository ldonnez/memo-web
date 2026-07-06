import { reflowTable, getPipePositions, getCellContentStart } from './format.js';

export function smartEnter(c, { formatTable, onEditorInput }) {
  const cursor = c.getCursor(),
    line = c.getLine(cursor.line);
  if (line[0] === '|' && line.split('|').length >= 4 && cursor.ch >= line.indexOf('|')) {
    formatTable(c, cursor.line + 1, onEditorInput);
    return;
  }
  let m = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ x]\]\s+)?)/);
  if (!m || cursor.ch < m[1].length) return CodeMirror.Pass;
  const rest = line.slice(m[1].length);
  if (!rest.trim()) {
    c.replaceRange('', { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
  } else {
    let prefix = m[1];
    if (/\[x\]/.test(prefix)) prefix = prefix.replace('[x]', '[ ]');
    m = prefix.match(/^(\s*)(\d+)([.)])/);
    if (m) prefix = m[1] + (parseInt(m[2], 10) + 1) + m[3] + ' ';
    c.replaceRange('\n' + prefix, { line: cursor.line, ch: cursor.ch });
  }
  onEditorInput();
}

export function toggleTaskByIndex(idx, cm, onEditorInput) {
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

export function formatTable(c, insertLine, onEditorInput) {
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
  let newRow = '|';
  for (let j = 0; j < cols; j++) newRow += ' ' + Array(widths[j] + 2).join(' ') + '|';
  const anchor = rowLines[rowLines.length - 1];
  lines.splice(anchor + 1, 0, newRow);
  c.setValue(lines.join('\n'));
  c.setCursor({ line: anchor + 1, ch: 1 });
  onEditorInput();
}

export function moveInTable(c, shift) {
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

export function handleTab(c) {
  if (moveInTable(c, false)) return;
  c.execCommand('insertSoftTab');
}

export function handleShiftTab(c) {
  if (moveInTable(c, true)) return;
  return CodeMirror.Pass;
}

export function toggleTaskOnLine(cm, currentFile, onEditorInput) {
  if (!cm || !currentFile) return;
  const cursor = cm.getCursor();
  const line = cm.getLine(cursor.line);
  const m = line.match(/^(\s*[-*+]\s+)\[([ x])\]\s*/);
  if (m) {
    const newCheck = m[2] === 'x' ? ' ' : 'x';
    const newLine = line.replace(/(\[)[ x](\])/, '$1' + newCheck + '$2');
    cm.replaceRange(newLine, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
    cm.focus();
    onEditorInput();
  } else {
    cm.replaceRange('- [ ] ', { line: cursor.line, ch: 0 });
    cm.setCursor({ line: cursor.line, ch: 6 });
    cm.focus();
    onEditorInput();
  }
}

export function insertMarkdown(before, after, cm, onEditorInput) {
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

export function insertTimestamp(cm, onEditorInput) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  insertMarkdown(ts, '', cm, onEditorInput);
}
