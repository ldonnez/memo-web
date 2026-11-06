export interface EditorActionInput {
  hasFile: boolean
  isDirty: boolean
  remotePending: boolean
  hasSha: boolean
}

export interface EditorActionState {
  canSave: boolean
  showRemote: boolean
  showDiscard: boolean
  canDelete: boolean
  hasMenuItems: boolean
}

export function editorActionState(input: EditorActionInput): EditorActionState {
  const canSave = input.hasFile && input.isDirty
  const showRemote = input.hasFile && input.remotePending
  const showDiscard = input.hasFile && input.isDirty
  const canDelete = input.hasFile && input.hasSha
  return {
    canSave,
    showRemote,
    showDiscard,
    canDelete,
    hasMenuItems: showRemote || showDiscard || canDelete,
  }
}
