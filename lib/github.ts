import { draftCache, contentCache } from './draft.ts'
import { arrayToBase64, cacheNotesToLocalStorage } from './util.ts'
import type { Config, Dir, DirWithType, GhFileData, GhFileEntry, Note } from './types.ts'

export interface EntriesResult {
  dirs: Dir[]
  notes: Note[]
}

export function parseEntries(
  entries: Array<{
    type?: string
    name?: string
    path?: string
    sha?: string
    size?: number
    last_modified?: string | null
  }>,
  ext: string,
): EntriesResult {
  return {
    dirs: entries
      .filter((i): i is typeof i & { type: 'dir'; name: string; path: string } => i.type === 'dir')
      .map(i => ({ name: i.name!, path: i.path! }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    notes: entries
      .filter(
        (i): i is typeof i & { type: 'file'; name: string; path: string; sha: string; size: number } =>
          i.type === 'file' && !!i.name && i.name.endsWith(ext),
      )
      .map(i => ({
        name: i.name!,
        path: i.path!,
        sha: i.sha ?? null,
        size: i.size ?? 0,
        date: i.last_modified || '',
        dirty: draftCache.has(i.path!) || false,
        content: null,
        originalText: '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export function buildStatusText(total: number, dirCount: number): string {
  return `${total} notes${dirCount ? ` · ${dirCount} folders` : ''}`
}

const REQUEST_TIMEOUT_MS = 15000

function requestTimeout(config: Config): AbortSignal {
  return AbortSignal.timeout(config.ghTimeoutMs || REQUEST_TIMEOUT_MS)
}

function isTimeoutError(e: unknown): boolean {
  return (
    !!e &&
    typeof e === 'object' &&
    'name' in e &&
    (e.name === 'AbortError' ||
      e.name === 'TimeoutError' ||
      (e as { code?: number | string }).code === 20 ||
      (e as { code?: number | string }).code === 'ERR_ABORTED')
  )
}

function timeoutError(): Error {
  return new Error('Request timed out. Check your connection and try again.')
}

interface RepoData {
  full_name: string
  name: string
  default_branch: string
}

export async function verifyRepo(config: Config): Promise<RepoData> {
  try {
    const res = await fetch(`https://api.github.com/repos/${config.ghOwner}/${config.ghRepo}`, {
      headers: {
        Authorization: `Bearer ${config.ghToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'MemoWeb',
      },
      signal: requestTimeout(config),
    })
    if (res.status === 404) {
      const err = (await res.json().catch(() => ({}))) as { message?: string }
      throw new Error(`Repository ${config.ghOwner}/${config.ghRepo} not found or no access. ${err.message || ''}`)
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { message?: string }
      throw new Error(err.message || `GitHub API error: ${res.status}`)
    }
    return (await res.json()) as RepoData
  } catch (e) {
    if (isTimeoutError(e)) throw timeoutError()
    if (e instanceof Error && (e.message.includes('Failed to fetch') || e.message.includes('NetworkError'))) {
      throw new Error('Cannot reach GitHub API. Are you offline or behind a firewall?')
    }
    throw e
  }
}

export async function gh<T = unknown>(config: Config, method: string, path: string, body?: unknown): Promise<T | null> {
  const url = `https://api.github.com${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.ghToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'MemoWeb',
  }
  const opts: RequestInit = { method, headers, signal: requestTimeout(config) }
  if (body) {
    headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(url, opts)
  } catch (e) {
    if (isTimeoutError(e)) throw timeoutError()
    throw e
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string }
    const msg = err.message || `GitHub API error ${res.status}`
    console.error('GitHub API error:', res.status, err)
    throw new Error(msg)
  }
  if (res.status === 204) return null
  return (await res.json()) as T
}

export async function ghGetFile(config: Config, path: string): Promise<GhFileData | null> {
  const ref = config.ghBranch || 'main'
  const encoded = encodeURIComponent(path)
  try {
    return await gh<GhFileData>(
      config,
      'GET',
      `/repos/${config.ghOwner}/${config.ghRepo}/contents/${encoded}?ref=${ref}`,
    )
  } catch (e) {
    if (e instanceof Error && (e.message.includes('Not Found') || e.message.includes('404'))) return null
    throw e
  }
}

export async function ghListDir(config: Config, path: string): Promise<GhFileEntry[] | []> {
  const ref = config.ghBranch || 'main'
  const encoded = encodeURIComponent(path)
  try {
    return (
      (await gh<GhFileEntry[]>(
        config,
        'GET',
        `/repos/${config.ghOwner}/${config.ghRepo}/contents/${encoded}?ref=${ref}`,
      )) || []
    )
  } catch (e) {
    if (e instanceof Error && (e.message.includes('Not Found') || e.message.includes('404'))) return []
    throw e
  }
}

interface PutFileResult {
  content: {
    sha: string
  }
}

export async function ghPutFile(
  config: Config,
  path: string,
  content: string | Uint8Array,
  message: string,
  sha?: string | null,
): Promise<PutFileResult> {
  const encoded = encodeURIComponent(path)
  const body: Record<string, unknown> = {
    message,
    content: typeof content === 'string' ? btoa(content) : arrayToBase64(content),
    branch: config.ghBranch || 'main',
  }
  if (sha) body['sha'] = sha
  return (await gh<PutFileResult>(
    config,
    'PUT',
    `/repos/${config.ghOwner}/${config.ghRepo}/contents/${encoded}`,
    body,
  )) as PutFileResult
}

export async function ghDeleteFile(config: Config, path: string, sha: string, message?: string): Promise<unknown> {
  const encoded = encodeURIComponent(path)
  return await gh(config, 'DELETE', `/repos/${config.ghOwner}/${config.ghRepo}/contents/${encoded}`, {
    message: message || `Delete ${path}`,
    sha,
    branch: config.ghBranch || 'main',
  })
}

const CONTENT_CONCURRENCY = 5

export async function fetchAllNotesContent(config: Config, notes: Note[]): Promise<Note[]> {
  const updated = [...notes]
  const queue = updated.map((n, i) => ({ note: n, index: i })).filter(({ note }) => !note.content)

  for (let start = 0; start < queue.length; start += CONTENT_CONCURRENCY) {
    const batch = queue.slice(start, start + CONTENT_CONCURRENCY)
    await Promise.all(
      batch.map(async ({ note, index }) => {
        try {
          const data = await ghGetFile(config, note.path)
          if (data) {
            contentCache.set(note.path, data.content)
            updated[index] = { ...note, content: data.content, sha: data.sha }
          }
        } catch (e) {
          console.warn('Failed to prefetch content for', note.path, e instanceof Error ? e.message : e)
        }
      }),
    )
  }
  return updated
}

export async function walkAllDirsAndPrefetch(config: Config, rootPath: string, fileExt: string): Promise<void> {
  const dirs: string[] = [rootPath || '']
  const seen = new Set<string>()

  while (dirs.length) {
    const dir = dirs.shift()!
    if (seen.has(dir)) continue
    seen.add(dir)

    try {
      const entries = await ghListDir(config, dir)
      if (!Array.isArray(entries)) continue

      const files: Array<GhFileEntry & { type: 'file' }> = []
      for (const item of entries) {
        if (item.type === 'dir') {
          dirs.push(item.path)
        } else if (item.type === 'file' && item.name.endsWith(fileExt)) {
          files.push(item as GhFileEntry & { type: 'file' })
        }
      }

      const notes: Note[] = files.map(f => ({
        name: f.name,
        path: f.path,
        sha: f.sha,
        size: f.size,
        date: f.last_modified || '',
        dirty: false,
        content: null,
        decrypted: null,
        originalText: '',
      }))

      const withContent = await fetchAllNotesContent(config, notes)
      await cacheNotesToLocalStorage(
        withContent,
        entries.filter((e): e is DirWithType => e.type === 'dir').map(e => ({ name: e.name, path: e.path })),
        dir,
      )
    } catch (e) {
      console.warn('walkAllDirsAndPrefetch error for', dir, e instanceof Error ? e.message : e)
    }
  }
}
