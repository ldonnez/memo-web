import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { getUrlParam, setUrlParams, clearUrlPath } from '../lib/util.js';

describe('getUrlParam', () => {
  it('reads from URLSearchParams', () => {
    const prev = global.window;
    global.window = { location: { search: '?owner=test&repo=repo' } };
    assert.equal(getUrlParam('owner'), 'test');
    assert.equal(getUrlParam('repo'), 'repo');
    assert.equal(getUrlParam('missing'), '');
    global.window = prev;
  });
});

describe('setUrlParams', () => {
  it('adds a param to the URL', () => {
    const prevWindow = global.window;
    const history = [];
    global.window = {
      location: { pathname: '/', search: '' },
      history: {
        replaceState(_, __, url) {
          history.push(url);
        },
      },
    };
    setUrlParams({ key: 'value' });
    assert.equal(history[0], '/?key=value');
    global.window = prevWindow;
  });

  it('removes a param when value is empty', () => {
    const prevWindow = global.window;
    const history = [];
    global.window = {
      location: { pathname: '/', search: '?key=value' },
      history: {
        replaceState(_, __, url) {
          history.push(url);
        },
      },
    };
    setUrlParams({ key: '' });
    assert.equal(history[0], '/');
    global.window = prevWindow;
  });
});

describe('clearUrlPath', () => {
  it('removes path param from URL', () => {
    const prevWindow = global.window;
    const history = [];
    global.window = {
      location: { pathname: '/', search: '?path=notes/foo&other=x' },
      history: {
        replaceState(_, __, url) {
          history.push(url);
        },
      },
    };
    clearUrlPath();
    assert.equal(history[0], '/?other=x');
    global.window = prevWindow;
  });

  it('does nothing when path param is absent', () => {
    const prevWindow = global.window;
    const history = [];
    global.window = {
      location: { pathname: '/', search: '?other=x' },
      history: {
        replaceState(_, __, url) {
          history.push(url);
        },
      },
    };
    clearUrlPath();
    assert.equal(history[0], '/?other=x');
    global.window = prevWindow;
  });
});
