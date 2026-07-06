export function smartEnter(c, { formatTable, onEditorInput }) {
  const cursor = c.getCursor(),
    line = c.getLine(cursor.line);
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
    if (/\[x\]/.test(prefix)) prefix = prefix.replace('[x]', '[ ]');
    m = prefix.match(/^(\s*)(\d+)([.)])/);
    if (m) prefix = m[1] + (parseInt(m[2], 10) + 1) + m[3] + ' ';
    c.replaceRange('\n' + prefix, { line: cursor.line, ch: cursor.ch });
  }
  onEditorInput();
}
