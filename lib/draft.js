export const contentCache = new Map();
export const draftCache = new Map();

export function persistDrafts() {
  try {
    const obj = {};
    for (const [k, v] of draftCache) obj[k] = v;
    localStorage.setItem('memoweb_drafts', JSON.stringify(obj));
  } catch (e) {
    console.warn('Failed to persist drafts:', e);
  }
}

export function restoreDrafts() {
  try {
    const raw = localStorage.getItem('memoweb_drafts');
    if (raw) {
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) draftCache.set(k, v);
    }
  } catch (e) {
    console.warn('Failed to restore drafts:', e);
  }
}

export function saveDraft(path, content) {
  draftCache.set(path, content);
  persistDrafts();
}

export function removeDraft(path) {
  draftCache.delete(path);
  persistDrafts();
}

export function removeCachedContent(path) {
  contentCache.delete(path);
}

export function pruneContentCache(notes, dirPath) {
  const prefix = dirPath ? dirPath + '/' : '';
  const alive = new Set(notes.map(n => n.path));
  for (const path of [...contentCache.keys()]) {
    if (path.startsWith(prefix) && !alive.has(path)) {
      contentCache.delete(path);
    }
  }
}
