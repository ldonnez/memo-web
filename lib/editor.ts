import { EditorView } from '@codemirror/view'
import { replaceDoc, replaceRange, setCursor, toOffset, offsetToDocPos, insertSoftTab } from './cm.ts'
import { reflowTable, getPipePositions, getCellContentStart } from './format.ts'
import type { Note } from './types.ts'

export const PASS = Symbol('pass')

export interface EditorContext {
  formatTable: (view: EditorView, insertLine: number, onEditorInput: () => void) => void
  onEditorInput: () => void
}

export function smartEnter(view: EditorView, { formatTable, onEditorInput }: EditorContext): symbol | void {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const cursorCh = head - line.from
  if (line.text[0] === '|' && line.text.split('|').length >= 4 && cursorCh >= line.text.indexOf('|')) {
    formatTable(view, line.number, onEditorInput)
    return
  }
  let m = line.text.match(/^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ x]\]\s+)?)/)
  if (!m || cursorCh < m[1]!.length) return PASS
  const rest = line.text.slice(m[1]!.length)
  if (!rest.trim()) {
    replaceRange(view, '', line.from, line.to)
  } else {
    let prefix = m[1]!
    if (/\[x\]/.test(prefix)) prefix = prefix.replace('[x]', '[ ]')
    m = prefix.match(/^(\s*)(\d+)([.)])/)
    if (m) prefix = m[1]! + (parseInt(m[2]!, 10) + 1) + m[3]! + ' '
    replaceRange(view, '\n' + prefix, head)
  }
  onEditorInput()
}

export function toggleTaskByIndex(idx: number, view: EditorView | null, onEditorInput: () => void): void {
  const content = view
    ? view.state.doc.toString()
    : (document.getElementById('editorContent') as HTMLTextAreaElement | null)?.value || ''
  const lines = content.split('\n')
  let count = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^(\s*[-*+]\s+)\[([ x])\]\s*/)
    if (m) {
      if (count === idx) {
        const newCheck = m[2]! === 'x' ? ' ' : 'x'
        const newLine = lines[i]!.replace(/(\[)[ x](\])/, '$1' + newCheck + '$2')
        if (view) {
          const line = view.state.doc.line(i + 1)
          replaceRange(view, newLine, line.from, line.to)
        } else {
          const ta = document.getElementById('editorContent') as HTMLTextAreaElement
          ta.value = content.replace(lines[i]!, newLine)
          ta.dispatchEvent(new Event('input'))
        }
        onEditorInput()
        return
      }
      count++
    }
  }
}

export function formatTable(view: EditorView, insertLine: number, onEditorInput: () => void): void {
  const lines = view.state.doc.toString().split('\n')
  const n = lines.length
  let start = insertLine
  while (start > 0 && lines[start - 1] && lines[start - 1]![0] === '|') start--
  let end = insertLine
  while (end < n - 1 && lines[end + 1] && lines[end + 1]![0] === '|') end++
  const rowLines: number[] = []
  const rowParts: string[][] = []
  let cols = 0
  for (let i = start; i <= end; i++) {
    if (!lines[i] || lines[i]![0] !== '|') continue
    const parts = lines[i]!.split('|')
    parts.shift()
    parts.pop()
    rowLines.push(i)
    rowParts.push(parts)
    if (parts.length > cols) cols = parts.length
  }
  if (cols < 2) {
    replaceRange(view, '\n', toOffset(view, { line: insertLine, ch: 0 }))
    setCursor(view, { line: insertLine + 1, ch: 0 })
    return
  }
  const widths = reflowTable(lines, rowLines, rowParts, cols)
  let newRow = '|'
  for (let j = 0; j < cols; j++) newRow += ' ' + Array(widths[j]! + 2).join(' ') + '|'
  const anchor = rowLines[rowLines.length - 1]!
  lines.splice(anchor + 1, 0, newRow)
  replaceDoc(view, lines.join('\n'))
  setCursor(view, { line: anchor + 1, ch: 1 })
  onEditorInput()
}

export function moveInTable(view: EditorView, shift: boolean): boolean {
  const cur = offsetToDocPos(view, view.state.selection.main.head)
  const line = view.state.doc.line(cur.line + 1).text
  if (!line.match(/^\|/) || line.split('|').length < 3) return false
  const pipes = getPipePositions(line)
  let cell = -1
  for (let i = 0; i < pipes.length - 1; i++) {
    if (cur.ch >= pipes[i]! && cur.ch < pipes[i + 1]!) {
      cell = i
      break
    }
  }
  if (cell < 0) return false
  const target = shift ? cell - 1 : cell + 1
  if (target < 0 || target >= pipes.length - 1) return false
  const pos = getCellContentStart(line, pipes[target]!)
  if (pos < 0) return false
  setCursor(view, { line: cur.line, ch: pos })
  return true
}

export function handleTab(view: EditorView): void {
  if (moveInTable(view, false)) return
  insertSoftTab(view)
}

export function handleShiftTab(view: EditorView): symbol | void {
  if (moveInTable(view, true)) return
  return PASS
}

export function toggleTaskOnLine(view: EditorView | null, currentFile: Note | null, onEditorInput: () => void): void {
  if (!view || !currentFile) return
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const m = line.text.match(/^(\s*[-*+]\s+)\[([ x])\]\s*/)
  if (m) {
    const newCheck = m[2]! === 'x' ? ' ' : 'x'
    const newLine = line.text.replace(/(\[)[ x](\])/, '$1' + newCheck + '$2')
    replaceRange(view, newLine, line.from, line.to)
    view.focus()
    onEditorInput()
  } else {
    replaceRange(view, '- [ ] ', line.from)
    setCursor(view, { line: line.number - 1, ch: 6 })
    view.focus()
    onEditorInput()
  }
}

export function insertMarkdown(
  before: string,
  after: string,
  view: EditorView | null,
  onEditorInput: () => void,
): void {
  if (view) {
    const sel = view.state.selection.main
    const selected = view.state.sliceDoc(sel.from, sel.to)
    const from = offsetToDocPos(view, sel.from)
    view.dispatch(view.state.replaceSelection(before + selected + after))
    if (!selected) {
      setCursor(view, { line: from.line, ch: from.ch + before.length })
    }
    view.focus()
    onEditorInput()
    return
  }
  const ta = document.getElementById('editorContent') as HTMLTextAreaElement
  const start = ta.selectionStart
  const end = ta.selectionEnd
  const text = ta.value
  const selected = text.substring(start, end)
  ta.value = text.substring(0, start) + before + selected + after + text.substring(end)
  ta.selectionStart = start + before.length
  ta.selectionEnd = start + before.length + selected.length
  ta.focus()
  onEditorInput()
}

export function insertTimestamp(view: EditorView | null, onEditorInput: () => void): void {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  insertMarkdown(ts, '', view, onEditorInput)
}
