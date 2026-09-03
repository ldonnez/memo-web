export const contentCache = new Map<string, string>()
export const draftCache = new Map<string, string>()

export function persistDrafts(): void {
  try {
    const obj: Record<string, string> = {}
    for (const [k, v] of draftCache) obj[k] = v
    localStorage.setItem('memoweb_drafts', JSON.stringify(obj))
  } catch (e) {
    console.warn('Failed to persist drafts:', e)
  }
}

export function restoreDrafts(): void {
  try {
    const raw = localStorage.getItem('memoweb_drafts')
    if (raw) {
      const obj: Record<string, string> = JSON.parse(raw)
      for (const [k, v] of Object.entries(obj)) draftCache.set(k, v)
    }
  } catch (e) {
    console.warn('Failed to restore drafts:', e)
  }
}

export function saveDraft(path: string, content: string): void {
  draftCache.set(path, content)
  persistDrafts()
}

export function removeDraft(path: string): void {
  draftCache.delete(path)
  persistDrafts()
}

export function removeCachedContent(path: string): void {
  contentCache.delete(path)
}

export function pruneContentCache(notes: { path: string }[], dirPath: string): void {
  const prefix = dirPath ? dirPath + '/' : ''
  const alive = new Set(notes.map(n => n.path))
  for (const path of [...contentCache.keys()]) {
    if (path.startsWith(prefix) && !alive.has(path)) {
      contentCache.delete(path)
    }
  }
}
