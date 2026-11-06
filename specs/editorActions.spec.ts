import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { editorActionState } from '../lib/editorActions.ts'

const base = { hasFile: true, isDirty: false, remotePending: false, hasSha: true }

describe('editorActionState', () => {
  it('offers delete only for a saved note', () => {
    const state = editorActionState(base)
    assert.equal(state.canDelete, true)
    assert.equal(state.canSave, false)
    assert.equal(state.showDiscard, false)
    assert.equal(state.showRemote, false)
    assert.equal(state.hasMenuItems, true)
  })

  it('offers save and discard when dirty', () => {
    const state = editorActionState({ ...base, isDirty: true })
    assert.equal(state.canSave, true)
    assert.equal(state.showDiscard, true)
  })

  it('offers remote only while a conflict is pending', () => {
    const state = editorActionState({ ...base, remotePending: true })
    assert.equal(state.showRemote, true)
    assert.equal(state.hasMenuItems, true)
  })

  it('keeps discard for an unsaved new note', () => {
    const state = editorActionState({ ...base, hasSha: false, isDirty: true })
    assert.equal(state.canDelete, false)
    assert.equal(state.showDiscard, true)
    assert.equal(state.hasMenuItems, true)
  })

  it('hides the menu when no note is open', () => {
    const state = editorActionState({ hasFile: false, isDirty: true, remotePending: true, hasSha: true })
    assert.equal(state.canSave, false)
    assert.equal(state.showDiscard, false)
    assert.equal(state.showRemote, false)
    assert.equal(state.canDelete, false)
    assert.equal(state.hasMenuItems, false)
  })
})
