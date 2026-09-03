import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { EditorView, keymap, Decoration, drawSelection, dropCursor } from '@codemirror/view'
import { EditorState, Compartment, Prec, StateField, type Extension } from '@codemirror/state'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import {
  indentOnInput,
  bracketMatching,
  foldKeymap,
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
  type Language,
} from '@codemirror/language'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { jsonLanguage } from '@codemirror/lang-json'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { pythonLanguage } from '@codemirror/lang-python'
import { cssLanguage } from '@codemirror/lang-css'
import { htmlLanguage } from '@codemirror/lang-html'
import { sql } from '@codemirror/lang-sql'
import { tags } from '@lezer/highlight'
import { markField, addMarkEffect, type MarkData } from '../lib/cm.ts'

// Mirrors the extension set built in lib/cm.js createEditor(). If any
// @codemirror/@lezer package resolves to a duplicate instance, EditorState.create
// throws "Unrecognized extension value in extension set (...)".
function createEditorState(extensions: Extension[]) {
  return EditorState.create({ doc: '# hello\n\n- [ ] task', extensions })
}

function baseExtensions() {
  const codeLanguages = (info: string): Language | null => {
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
      md: markdownLanguage,
      markdown: markdownLanguage,
    }
    return map[info] || null
  }
  return [
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle),
    history(),
    markdown({ base: markdownLanguage, codeLanguages }),
    EditorView.lineWrapping,
    EditorState.tabSize.of(2),
    keymap.of([...markdownKeymap, ...foldKeymap, ...historyKeymap, ...defaultKeymap]),
  ]
}

describe('CodeMirror 6 (single module graph via Vite)', () => {
  it('accepts the full editor extension set in EditorState.create', () => {
    const markField = StateField.define({
      create: () => ({ marks: [], decoration: Decoration.none }),
      update(value, tr) {
        if (!tr.docChanged) return value
        return value
      },
      provide: f => EditorView.decorations.from(f, v => v.decoration),
    })
    const state = createEditorState([...baseExtensions(), markField, Prec.high(keymap.of([]))])
    assert.equal(state.doc.lines, 3)
  })

  it('reconfigures a theme Compartment with a freshly defined HighlightStyle', () => {
    const themeCompartment = new Compartment()
    const state = createEditorState([
      ...baseExtensions(),
      themeCompartment.of(syntaxHighlighting(defaultHighlightStyle)),
    ])
    const custom = HighlightStyle.define([{ tag: tags.heading, color: '#c00' }])
    const next = state.update({ effects: themeCompartment.reconfigure(syntaxHighlighting(custom)) })
    assert.ok(next.state)
  })

  it('rebuilds mark decorations from out-of-order mark ranges without throwing', () => {
    const state = EditorState.create({
      doc: 'abcdefghij',
      extensions: [markField],
    })
    const unsorted: MarkData[] = [
      { id: 1, from: 6, to: 8, className: 'cm-search-match' },
      { id: 2, from: 2, to: 4, className: 'cm-search-match' },
      { id: 3, from: 2, to: 3, className: 'cm-search-current' },
    ]
    const next = state.update({ effects: addMarkEffect.of(unsorted) })
    const decoration = next.state.field(markField).decoration
    assert.equal(decoration.size, unsorted.length)
  })
})
