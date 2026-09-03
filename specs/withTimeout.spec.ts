import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { withTimeout } from '../lib/util.ts'

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

describe('withTimeout', () => {
  it('resolves with the promise value when it finishes before the timeout', async () => {
    const result = await withTimeout(Promise.resolve('done'), 500)
    assert.strictEqual(result, 'done')
  })

  it('rejects when the timeout elapses before the promise settles', async () => {
    await assert.rejects(
      withTimeout(
        delay(50).then(() => 'late'),
        10,
      ),
      /Timed out/,
    )
  })

  it('the timeout still fires even if the promise rejects later', async () => {
    const p = delay(30).then(() => {
      throw new Error('underlying failure')
    })
    await assert.rejects(withTimeout(p, 5), /Timed out/)
  })

  it('propagates the rejection when the promise rejects before the timeout', async () => {
    await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 500), /boom/)
  })

  it('calls onTimeout when the timeout elapses', async () => {
    let fired = false
    await assert.rejects(withTimeout(delay(40), 5, () => (fired = true)))
    assert.strictEqual(fired, true)
  })

  it('does not call onTimeout when the promise settles first', async () => {
    let fired = false
    const result = await withTimeout(Promise.resolve(1), 10, () => (fired = true))
    assert.strictEqual(result, 1)
    assert.strictEqual(fired, false)
  })

  it('uses the provided message for the timeout error', async () => {
    await assert.rejects(withTimeout(delay(40), 5, undefined, 'Custom message'), /Custom message/)
  })
})
