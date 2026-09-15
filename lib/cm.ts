// CodeMirror 6 — Vite bundles all @codemirror/* packages into a single module
// graph, guaranteeing one instance of every library (no duplicate instanceof).
import {
  EditorView,
  keymap,
  Decoration,
  drawSelection,
  dropCursor,
  type DecorationSet,
  type KeyBinding,
} from '@codemirror/view'
import { catppuccinFrappe, catppuccinLatte } from '@catppuccin/codemirror'
import {
  EditorState,
  Compartment,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import {
  indentOnInput,
  bracketMatching,
  foldKeymap,
  syntaxHighlighting,
  HighlightStyle,
  LRLanguage,
  type Language,
} from '@codemirror/language'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { jsonLanguage } from '@codemirror/lang-json'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { pythonLanguage } from '@codemirror/lang-python'
import { cssLanguage } from '@codemirror/lang-css'
import { htmlLanguage } from '@codemirror/lang-html'
import { sql } from '@codemirror/lang-sql'
import { parser as bashParser } from '@fig/lezer-bash'
import { tags } from '@lezer/highlight'

export const tabSize = 2

let markSeq = 0
let themeCompartment: Compartment
let historyCompartment: Compartment

export const addMarkEffect = StateEffect.define<MarkData[]>()
export const clearAllMarksEffect = StateEffect.define<void>()
export const removeMarksEffect = StateEffect.define<number[]>()

export interface MarkData {
  id: number
  from: number
  to: number
  className: string
}

interface MarkFieldValue {
  marks: MarkData[]
  decoration: DecorationSet
}

function buildDecorations(marks: MarkData[]): DecorationSet {
  if (!marks.length) return Decoration.none
  const builder = new RangeSetBuilder<Decoration>()
  for (const m of [...marks].sort((a, b) => a.from - b.from || a.to - b.to)) {
    builder.add(m.from, m.to, Decoration.mark({ class: m.className }))
  }
  return builder.finish()
}

export const markField = StateField.define<MarkFieldValue>({
  create() {
    return { marks: [], decoration: Decoration.none }
  },
  update(value, tr) {
    let { marks } = value
    if (tr.effects.some(e => e.is(clearAllMarksEffect))) {
      marks = []
    } else {
      const removed = new Set(tr.effects.flatMap(e => (e.is(removeMarksEffect) ? e.value : [])))
      if (removed.size) marks = marks.filter(m => !removed.has(m.id))
    }
    if (tr.docChanged) {
      marks = marks
        .map(m => ({ ...m, from: tr.changes.mapPos(m.from), to: tr.changes.mapPos(m.to) }))
        .filter(m => m.from < m.to)
    }
    for (const e of tr.effects) {
      if (e.is(addMarkEffect)) {
        for (const cfg of e.value) {
          marks.push({ id: cfg.id, className: cfg.className, from: cfg.from, to: cfg.to })
        }
      }
    }
    return { marks, decoration: buildDecorations(marks) }
  },
  provide: f => EditorView.decorations.from(f, v => v.decoration),
})

// Bash/shell — no official @codemirror/lang-bash, so wrap the @fig/lezer-bash
// LRParser in a Language so fenced bash/sh/shell blocks parse.
const bashLanguage = LRLanguage.define({ name: 'bash', parser: bashParser })

// Per-flavor syntax colors (Catppuccin palettes). Each highlight style also
// covers markdown links/URLs and todo markers, which is why we DON'T rely on
// @codemirror/language's defaultHighlightStyle (it applies light-background
// colors — e.g. dark blue #221199 for URLs/todo — that are unreadable on the
// dark Frappe background).
const frappeHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: '#838ba7', fontStyle: 'italic' },
  { tag: [tags.string, tags.regexp, tags.special(tags.variableName)], color: '#a6d189' },
  { tag: tags.variableName, color: '#c6d0f5' },
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword], color: '#ca9ee6' },
  { tag: [tags.operator, tags.logicOperator], color: '#a5adce' },
  { tag: [tags.number, tags.bool], color: '#ef9f76' },
  { tag: [tags.typeName, tags.className, tags.standard(tags.variableName)], color: '#99d1db' },
  { tag: tags.function(tags.variableName), color: '#8caaee' },
  { tag: tags.propertyName, color: '#8caaee' },
  { tag: [tags.meta, tags.annotation], color: '#f2d5cf' },
  { tag: [tags.link, tags.url], color: '#85c1dc', textDecoration: 'underline' },
  { tag: tags.atom, color: '#ef9f76' },
  { tag: tags.heading, fontWeight: '600', color: '#8caaee' },
  { tag: tags.strong, fontWeight: '700', color: '#c6d0f5' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.monospace, color: '#c6d0f5' },
  { tag: tags.invalid, color: '#e78284' },
  { tag: [tags.brace, tags.paren, tags.squareBracket, tags.separator], color: '#a5adce' },
  { tag: tags.name, color: '#85c1dc' },
])

const latteHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: '#8c8fa1', fontStyle: 'italic' },
  { tag: [tags.string, tags.regexp, tags.special(tags.variableName)], color: '#40a02b' },
  { tag: tags.variableName, color: '#4c4f69' },
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword], color: '#8839ef' },
  { tag: [tags.operator, tags.logicOperator], color: '#5c5f77' },
  { tag: [tags.number, tags.bool], color: '#fe640b' },
  { tag: [tags.typeName, tags.className, tags.standard(tags.variableName)], color: '#04a5e5' },
  { tag: tags.function(tags.variableName), color: '#1e66f5' },
  { tag: tags.propertyName, color: '#1e66f5' },
  { tag: [tags.meta, tags.annotation], color: '#dc8a78' },
  { tag: [tags.link, tags.url], color: '#209fb5', textDecoration: 'underline' },
  { tag: tags.atom, color: '#fe640b' },
  { tag: tags.heading, fontWeight: '600', color: '#1e66f5' },
  { tag: tags.strong, fontWeight: '700', color: '#4c4f69' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.monospace, color: '#4c4f69' },
  { tag: tags.invalid, color: '#d20f39' },
  { tag: [tags.brace, tags.paren, tags.squareBracket, tags.separator], color: '#5c5f77' },
  { tag: tags.name, color: '#04a5e5' },
])

export type ThemeName = 'latte' | 'frappe'

function getTheme(themeName: ThemeName): Extension[] {
  if (themeName === 'latte') {
    return [catppuccinLatte, syntaxHighlighting(latteHighlightStyle)]
  }
  return [catppuccinFrappe, syntaxHighlighting(frappeHighlightStyle)]
}

// Map fenced `info` strings to Language objects (lang-markdown's codeLanguages
// must return a Language, not a LanguageSupport factory, or code stays plain).
function codeLanguages(info: string): Language | null {
  const map: Record<string, Language> = {
    json: jsonLanguage,
    js: javascriptLanguage,
    javascript: javascriptLanguage,
    py: pythonLanguage,
    python: pythonLanguage,
    css: cssLanguage,
    html: htmlLanguage,
    xml: htmlLanguage,
    sql: sql().language,
    bash: bashLanguage,
    sh: bashLanguage,
    shell: bashLanguage,
    md: markdownLanguage,
    markdown: markdownLanguage,
  }
  return map[info] || null
}

// ── Position helpers ──

// A position may be a CM6 integer offset or a CM5-style {line, ch} object (0-based line)
export function toOffset(view: EditorView, pos: number | { line: number; ch: number }): number {
  if (typeof pos === 'number') return pos
  const n = Math.min(pos.line, view.state.doc.lines - 1)
  const line = view.state.doc.line(n + 1)
  return line.from + Math.min(pos.ch, line.length)
}

export function offsetToDocPos(view: EditorView, offset: number): { line: number; ch: number } {
  const line = view.state.doc.lineAt(offset)
  return { line: line.number - 1, ch: offset - line.from }
}

// ── View-level ops (compartments live at module scope, set up in createEditor) ──

export function setTheme(view: EditorView, name: ThemeName): void {
  view.dispatch({ effects: themeCompartment.reconfigure(getTheme(name)) })
}

export function clearHistory(view: EditorView): void {
  view.dispatch({ effects: historyCompartment.reconfigure(history()) })
}

export function replaceDoc(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
}

export function setCursor(view: EditorView, pos: number | { line: number; ch: number }, scroll?: boolean): void {
  const dispatchOpts = scroll === false ? {} : { scrollIntoView: true }
  view.dispatch({ selection: { anchor: toOffset(view, pos) }, ...dispatchOpts })
}

export function setSelection(view: EditorView, from: number, to: number): void {
  view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true })
}

export function replaceRange(view: EditorView, text: string, from: number, to?: number): void {
  view.dispatch({
    changes: {
      from,
      ...(to !== undefined ? { to } : {}),
      insert: text,
    },
  })
}

export function insertSoftTab(view: EditorView): void {
  const { head } = view.state.selection.main
  const line = view.state.doc.lineAt(head)
  const col = head - line.from
  const spaces = tabSize - (col % tabSize)
  view.dispatch({ changes: { from: head, insert: ' '.repeat(spaces) } })
}

export interface CmMark {
  clear: () => void
}

export function addMark(view: EditorView, from: number, to: number, className?: string): CmMark {
  const id = ++markSeq
  view.dispatch({
    effects: addMarkEffect.of([{ id, from, to, className: className || '' }]),
  })
  return { clear: () => view.dispatch({ effects: removeMarksEffect.of([id]) }) }
}

export function clearAllMarks(view: EditorView): void {
  view.dispatch({ effects: clearAllMarksEffect.of() })
}

export function getAllMarks(view: EditorView): CmMark[] {
  return view.state.field(markField).marks.map(m => ({
    clear: () => view.dispatch({ effects: removeMarksEffect.of([m.id]) }),
  }))
}

export interface CreateEditorOptions {
  parent: HTMLElement
  initialValue?: string
  onChange?: () => void
  themeName?: ThemeName
  keymapBindings?: KeyBinding[]
}

export function createEditor({
  parent,
  initialValue,
  onChange,
  themeName,
  keymapBindings,
}: CreateEditorOptions): EditorView {
  themeCompartment = new Compartment()
  historyCompartment = new Compartment()

  const extensions: Extension[] = [
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    themeCompartment.of(getTheme(themeName || 'frappe')),
    historyCompartment.of(history()),
    markdown({
      base: markdownLanguage,
      codeLanguages,
    }),
    EditorView.lineWrapping,
    EditorState.tabSize.of(tabSize),
    EditorView.updateListener.of(update => {
      if (update.docChanged && onChange) onChange()
    }),
    markField,
    Prec.high(keymap.of(keymapBindings || [])),
    keymap.of([...markdownKeymap, ...foldKeymap, ...historyKeymap, ...defaultKeymap]),
  ]

  const state = EditorState.create({
    doc: initialValue || '',
    extensions,
  })
  return new EditorView({ state, parent })
}
