import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { highlightCode } from '../lib/util.js';

describe('highlightCode', () => {
  it('falls back to escHtml when hljs is not provided', () => {
    assert.equal(highlightCode('<script>', 'js', null), '&lt;script&gt;');
  });

  it('falls back to escHtml when lang is unknown', () => {
    const mock = { getLanguage: () => null };
    assert.equal(highlightCode('<script>', 'unknown', mock), '&lt;script&gt;');
  });

  it('uses hljs when language is available', () => {
    const mock = {
      getLanguage: () => true,
      highlight: (code, opts) => ({ value: '<span class="hljs-keyword">var</span>' }),
    };
    assert.equal(highlightCode('var x = 1;', 'js', mock), '<span class="hljs-keyword">var</span>');
  });
});
