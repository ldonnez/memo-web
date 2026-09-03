import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { getUrlParam, setUrlParams, clearUrlPath } from '../lib/util.ts'

describe('getUrlParam', () => {
  it('reads from URLSearchParams', () => {
    const prev = global.window
    global.window = { location: { search: '?owner=test&repo=repo' } } as unknown as Window & typeof globalThis
    assert.equal(getUrlParam('owner'), 'test')
    assert.equal(getUrlParam('repo'), 'repo')
    assert.equal(getUrlParam('missing'), '')
    global.window = prev
  })
})

describe('setUrlParams', () => {
  it('adds a param to the URL', () => {
    const prevWindow = global.window
    const history: string[] = []
    global.window = {
      location: { pathname: '/', search: '' },
      history: {
        replaceState(_: unknown, __: string, url?: string | URL | null): void {
          history.push(String(url))
        },
      },
    } as unknown as Window & typeof globalThis
    setUrlParams({ key: 'value' })
    assert.equal(history[0], '/?key=value')
    global.window = prevWindow
  })

  it('removes a param when value is empty', () => {
    const prevWindow = global.window
    const history: string[] = []
    global.window = {
      location: { pathname: '/', search: '?key=value' },
      history: {
        replaceState(_: unknown, __: string, url?: string | URL | null): void {
          history.push(String(url))
        },
      },
    } as unknown as Window & typeof globalThis
    setUrlParams({ key: '' })
    assert.equal(history[0], '/')
    global.window = prevWindow
  })
})

describe('clearUrlPath', () => {
  it('removes path param from URL', () => {
    const prevWindow = global.window
    const history: string[] = []
    global.window = {
      location: { pathname: '/', search: '?path=notes/foo&other=x' },
      history: {
        replaceState(_: unknown, __: string, url?: string | URL | null): void {
          history.push(String(url))
        },
      },
    } as unknown as Window & typeof globalThis
    clearUrlPath()
    assert.equal(history[0], '/?other=x')
    global.window = prevWindow
  })

  it('does nothing when path param is absent', () => {
    const prevWindow = global.window
    const history: string[] = []
    global.window = {
      location: { pathname: '/', search: '?other=x' },
      history: {
        replaceState(_: unknown, __: string, url?: string | URL | null): void {
          history.push(String(url))
        },
      },
    } as unknown as Window & typeof globalThis
    clearUrlPath()
    assert.equal(history[0], '/?other=x')
    global.window = prevWindow
  })
})
