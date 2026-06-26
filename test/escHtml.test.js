import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { escHtml } from '../lib/util.js';

describe('escHtml', () => {
  it('escapes HTML special chars', () => {
    assert.equal(escHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('leaves safe text unchanged', () => {
    assert.equal(escHtml('hello world'), 'hello world');
  });

  it('escapes & first', () => {
    assert.equal(escHtml('& < > "'), '&amp; &lt; &gt; &quot;');
  });
});
