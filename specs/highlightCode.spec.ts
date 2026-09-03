import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { highlightCode } from '../lib/util.ts'
import type { HLJSApi } from 'highlight.js'

describe('highlightCode', () => {
  it('falls back to escHtml when hljs is not provided', () => {
    assert.equal(highlightCode('<script>', 'js', null as unknown as HLJSApi), '&lt;script&gt;')
  })

  it('falls back to escHtml when lang is unknown', () => {
    const unknownLang: HLJSApi = {
      getLanguage: () => null,
      highlight: (code: string) => ({ value: code, language: '', relevance: 0, illegal: false }),
      highlightAuto: (code: string) => ({ value: code, language: '', relevance: 0, illegal: false }),
    } as unknown as HLJSApi
    assert.equal(highlightCode('<script>', 'unknown', unknownLang), '&lt;script&gt;')
  })

  it('uses hljs when language is available', () => {
    const mock = {
      getLanguage: () => true,
      highlight: (_code: string, _opts: unknown) => ({ value: '<span class="hljs-keyword">var</span>' }),
    } as unknown as HLJSApi
    assert.equal(highlightCode('var x = 1;', 'js', mock), '<span class="hljs-keyword">var</span>')
  })
})
