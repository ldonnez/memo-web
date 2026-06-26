import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { escAttr } from '../lib/util.js';

describe('escAttr', () => {
  it('escapes HTML attribute special chars', () => {
    assert.equal(escAttr('<"\'&>'), '&lt;&quot;&#39;&amp;&gt;');
  });

  it('leaves safe attribute values unchanged', () => {
    assert.equal(escAttr('hello-world'), 'hello-world');
  });

  it('escapes double quotes for attribute safety', () => {
    assert.equal(escAttr('evil" onclick="xss()"'), 'evil&quot; onclick=&quot;xss()&quot;');
  });
});
