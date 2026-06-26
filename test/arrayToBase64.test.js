import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { arrayToBase64 } from '../lib/util.js';

describe('arrayToBase64', () => {
  it('encodes a Uint8Array to base64', () => {
    const arr = Uint8Array.from([104, 101, 108, 108, 111]);
    assert.equal(arrayToBase64(arr), 'aGVsbG8=');
  });

  it('returns empty string for empty array', () => {
    assert.equal(arrayToBase64([]), '');
  });

  it('encodes binary data correctly', () => {
    const arr = Uint8Array.from([0, 255, 128, 64]);
    assert.equal(arrayToBase64(arr), 'AP+AQA==');
  });
});
