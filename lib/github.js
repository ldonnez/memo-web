import { draftCache, contentCache } from './draft.js';
import { arrayToBase64, cacheNotesToLocalStorage } from './util.js';

export function parseEntries(entries, ext) {
  return {
    dirs: entries
      .filter(i => i.type === 'dir')
      .map(i => ({ name: i.name, path: i.path }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    notes: entries
      .filter(i => i.type === 'file' && i.name.endsWith(ext))
      .map(i => ({
        name: i.name,
        path: i.path,
        sha: i.sha,
        size: i.size,
        date: i.last_modified || '',
        dirty: draftCache.has(i.path) || false,
        originalText: '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function buildStatusText(total, dirCount) {
  return `${total} notes${dirCount ? ` · ${dirCount} folders` : ''}`;
}

export async function verifyRepo(config) {
  try {
    const res = await fetch(`https://api.github.com/repos/${config.ghOwner}/${config.ghRepo}`, {
      headers: {
        Authorization: `Bearer ${config.ghToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'MemoWeb',
      },
    });
    if (res.status === 404) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Repository ${config.ghOwner}/${config.ghRepo} not found or no access. ${err.message || ''}`);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub API error: ${res.status}`);
    }
    return await res.json();
  } catch (e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      throw new Error('Cannot reach GitHub API. Are you offline or behind a firewall?');
    }
    throw e;
  }
}

export async function gh(config, method, path, body) {
  const url = `https://api.github.com${path}`;
  const headers = {
    Authorization: `Bearer ${config.ghToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'MemoWeb',
  };
  const opts = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.message || `GitHub API error ${res.status}`;
    console.error('GitHub API error:', res.status, err);
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function ghGetFile(config, path) {
  const ref = config.ghBranch || 'main';
  const encoded = encodeURIComponent(path);
  try {
    return await gh(config, 'GET', `/repos/${config.ghOwner}/${config.ghRepo}/contents/${encoded}?ref=${ref}`);
  } catch (e) {
    if (e.message.includes('Not Found') || e.message.includes('404')) return null;
    throw e;
  }
}

export async function ghListDir(config, path) {
  const ref = config.ghBranch || 'main';
  const encoded = encodeURIComponent(path);
  try {
    return await gh(config, 'GET', `/repos/${config.ghOwner}/${config.ghRepo}/contents/${encoded}?ref=${ref}`);
  } catch (e) {
    if (e.message.includes('Not Found') || e.message.includes('404')) return [];
    throw e;
  }
}

export async function ghPutFile(config, path, content, message, sha) {
  const encoded = encodeURIComponent(path);
  const body = {
    message,
    content: typeof content === 'string' ? btoa(content) : arrayToBase64(content),
    branch: config.ghBranch || 'main',
  };
  if (sha) body.sha = sha;
  return await gh(config, 'PUT', `/repos/${config.ghOwner}/${config.ghRepo}/contents/${encoded}`, body);
}

export async function ghDeleteFile(config, path, sha, message) {
  const encoded = encodeURIComponent(path);
  return await gh(config, 'DELETE', `/repos/${config.ghOwner}/${config.ghRepo}/contents/${encoded}`, {
    message: message || `Delete ${path}`,
    sha,
    branch: config.ghBranch || 'main',
  });
}

const CONTENT_CONCURRENCY = 5;

export async function fetchAllNotesContent(config, notes) {
  const updated = [...notes];
  const queue = updated.map((n, i) => ({ note: n, index: i })).filter(({ note }) => !note.content);

  for (let start = 0; start < queue.length; start += CONTENT_CONCURRENCY) {
    const batch = queue.slice(start, start + CONTENT_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ note, index }) => {
        try {
          const data = await ghGetFile(config, note.path);
          if (data) {
            contentCache.set(note.path, data.content);
            updated[index] = { ...note, content: data.content, sha: data.sha };
          }
        } catch (e) {
          console.warn('Failed to prefetch content for', note.path, e.message);
        }
      }),
    );
  }
  return updated;
}

export async function walkAllDirsAndPrefetch(config, rootPath, fileExt) {
  const dirs = [rootPath || ''];
  const seen = new Set();

  while (dirs.length) {
    const dir = dirs.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);

    try {
      const entries = await ghListDir(config, dir);
      if (!Array.isArray(entries)) continue;

      const files = [];
      for (const item of entries) {
        if (item.type === 'dir') {
          dirs.push(item.path);
        } else if (item.type === 'file' && item.name.endsWith(fileExt)) {
          files.push(item);
        }
      }

      const notes = files.map(f => ({
        name: f.name,
        path: f.path,
        sha: f.sha,
        size: f.size,
        date: f.last_modified || '',
        dirty: false,
        content: null,
        decrypted: null,
        originalText: '',
      }));

      const withContent = await fetchAllNotesContent(config, notes);
      await cacheNotesToLocalStorage(
        withContent,
        entries.filter(e => e.type === 'dir'),
        dir,
      );
    } catch (e) {
      console.warn('walkAllDirsAndPrefetch error for', dir, e.message);
    }
  }
}
