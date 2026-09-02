import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EditorView, keymap, Decoration, drawSelection, dropCursor } from '@codemirror/view';
import { EditorState, Compartment, Prec, StateField } from '@codemirror/state';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import {
  indentOnInput,
  bracketMatching,
  foldKeymap,
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
} from '@codemirror/language';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { sql } from '@codemirror/lang-sql';
import { tags } from '@lezer/highlight';

// Mirrors the extension set built in lib/cm.js createEditor(). If any
// @codemirror/@lezer package resolves to a duplicate instance, EditorState.create
// throws "Unrecognized extension value in extension set (...)".
function createEditorState(extensions) {
  return EditorState.create({ doc: '# hello\n\n- [ ] task', extensions });
}

function baseExtensions() {
  const codeLanguages = info => {
    const map = {
      json,
      js: javascript,
      javascript,
      py: python,
      python,
      css,
      html,
      xml: html,
      sql,
      md: markdownLanguage.support,
      markdown: markdownLanguage.support,
    };
    return map[info] || null;
  };
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
  ];
}

describe('CodeMirror 6 (single module graph via Vite)', () => {
  it('accepts the full editor extension set in EditorState.create', () => {
    const markField = StateField.define({
      create: () => ({ marks: [], decoration: Decoration.none }),
      update(value, tr) {
        if (!tr.docChanged) return value;
        return value;
      },
      provide: f => EditorView.decorations.from(f, v => v.decoration),
    });
    const state = createEditorState([...baseExtensions(), markField, Prec.high(keymap.of([]))]);
    assert.equal(state.doc.lines, 3);
  });

  it('reconfigures a theme Compartment with a freshly defined HighlightStyle', () => {
    const themeCompartment = new Compartment();
    const state = createEditorState([
      ...baseExtensions(),
      themeCompartment.of(syntaxHighlighting(defaultHighlightStyle)),
    ]);
    const custom = HighlightStyle.define([{ tag: tags.heading, color: '#c00' }]);
    const next = state.update({ effects: themeCompartment.reconfigure(syntaxHighlighting(custom)) });
    assert.ok(next.state);
  });
});
