# Memo Web — agent instructions

## Stack

- **Vanilla JS PWA** — no framework, no bundler (the `scripts/bundle.js` inlines into HTML for a separate deployment; not used day-to-day).
- **ESM** — `"type": "module"` in `package.json`, `<script type="module">` in HTML.
- **Service Worker** — `sw.js` with `CACHE = 'memo-vN'`. Bump version when CDN URLs change (old cache auto-deleted on activate).
- **All CSS lives in `<style>` in `index.html`** — no CSS files.
- **All JS logic in `app.js`** (~1314 lines). Imports from `lib/{crypto,draft,format,github,update,util}.js`.
- **CDN libraries** loaded via `<script>` tags with `integrity` + `crossorigin="anonymous"`. CSP `script-src` = `'self' https://cdn.jsdelivr.net`.

## Commands

```
npm run dev           # static server at http://localhost:8080 (required — ESM + SW need HTTP)
npm test              # node --test 'specs/**/*.spec.js'
npm run lint          # eslint .
npm run format        # prettier --write '**/*.{js,html,css,md,json}'
```

CI order: `npm install → npm run format:check → npm run lint → npm test` (lint and test are separate jobs; deploy gated on CI success).

## Testing

- Uses Node's built-in test runner (`node --test`). 251 tests across 19 files in `specs/`.
- Run single file: `node --test specs/crypto.spec.js`.
- Node 24 required (CI runs Node 24).
- Tests for `crypto.js` set up `globalThis.openpgp` in `before()` hook — that module needs it even in tests.

## Architecture

- **`index.html`** — shell with all CSS in `<style>`, CDN scripts in `<head>`, DOMPurify `<script>` + `<script type="module" src="app.js">` at end of `<body>`.
- **`app.js`** — application shell: state management, CodeMirror 5 editor, settings, preview rendering, pull-to-refresh. Entry point at bottom: `loadConfig()` then `init()`.
- **`sw.js`** — service worker. Caching: local assets stale-while-revalidate, CDN cache-first, API network-only, index.html network-first.
- **`lib/crypto.js`** — `encryptContent`/`decryptContent` using OpenPGP.js (symmetric or asymmetric).
- **`lib/update.js`** — `onUpdateAvailable` + `applyUpdate` for SW lifecycle.
- **`lib/format.js`** — Markdown table formatting (`reflowTable`, `getPipePositions`, `getCellContentStart`).
- **`lib/util.js`** — helpers: `escHtml`, `escAttr`, `highlightCode`, `computeDirtyState`, `formatNoteItem`, etc.
- **`lib/github.js`** — GitHub API client: `gh`, `ghGetFile`, `ghListDir`, `ghPutFile`, `ghDeleteFile`, `verifyRepo`, `parseEntries`, `buildStatusText`, `fetchAllNotesContent`, `walkAllDirsAndPrefetch`. All functions take `config` as first parameter.
- **`lib/draft.js`** — draft/content cache: `contentCache`, `draftCache`, `persistDrafts`, `restoreDrafts`, `saveDraft`, `removeDraft`. Module-level `Map` singletons backed by localStorage.
- **`byId()`** — `document.getElementById()` shorthand, defined at top of `app.js`.
- **`loadFromCache(path, extraState)`** — loads cached notes from IndexedDB on connection failure; shared by `connect` and `navigateToDir`.

## Conventions

- **No inline event handlers.** All event binding in `bindEvents()` function at bottom of `app.js`. No `'unsafe-inline'` in `script-src` CSP.
- **`style-src 'unsafe-inline'` retained** — hundreds of inline `style="..."` attributes not worth refactoring.
- **No HTML comments** in code. Minimal JS comments.
- **CodeMirror 5** (not CM6). Loaded with 10 modes. Custom `listitem` renderer for task checkboxes.
- **Marked v18.0.5** — loaded via CDN `<script>` with SRI. API: `marked.parse(text, { breaks, gfm })`, `marked.use({ renderer: { code, listitem } })`.
- **DOMPurify** — loaded via CDN `<script>` (no SRI — jsDelivr minifies dynamic file). Guard: `throw Error('DOMPurify not loaded')` if undefined.
- **ESLint globals** for CDN-injected libs: `CodeMirror`, `marked`, `DOMPurify`, `hljs`, `openpgp`, `prettier`, `prettierPlugins` — all set in `eslint.config.js`.
- **Prettier**: semicolons, single quotes, trailing commas, 120 print width, 2-space indent, no parens on single arrow param.
- **SRI hashes**: generate via `curl -sL URL | openssl dgst -sha384 -binary | openssl base64 -A` (direct pipe, NOT via shell variable — echo corrupts binary).
- **`specs/update.spec.js` mocks `navigator.serviceWorker`** — no real SW needed for unit tests.

## iOS / PWA quirks

- **CSS Highlights API**: used unconditionally — `CSS.highlights` is available in all modern browsers. `CSS.highlights.clear()` called directly, no feature detection or try/catch.
- **Inputs must be `font-size: 16px`** to prevent iOS auto-zoom on focus.
- **Service worker**: registered via `import('./lib/update.js')` (dynamic import avoids inline `<script>` block). SW `skipWaiting()` on install + `clients.claim()` on activate.

## Security

- CSP in `<meta>` tag: `default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; connect-src 'self' https://api.github.com`.
- `form-action 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, `upgrade-insecure-requests`.

## Maintaining

### CDN library updates

All CDN libraries are loaded from `https://cdn.jsdelivr.net` in `index.html` (static `<script>`/`<link>`) or dynamically in `app.js` (Prettier). After bumping a version:

1. **Regenerate the SRI hash** for every `<script>`/`<link>` that has `integrity`, using:

   ```
   curl -sL <URL> | openssl dgst -sha384 -binary | openssl base64 -A
   ```

   Pipe the URL through the command directly — do not use shell variables (binary corruption).

2. **DOMPurify** has no SRI (jsDelivr minifies a dynamic file). Just update the URL.

3. **Prettier** (`app.js:657,660`) is lazy-loaded at `@3` (major-only pin). No SRI needed.

4. **Bump `CACHE`** in `sw.js:2` (e.g. `'memo-v4'` → `'memo-v5'`) so the service worker fetches fresh CDN assets on activate.

5. Run the full CI suite: `npm run format:check && npm run lint && npm test`.

### npm dependency updates

Dev-only: `eslint`, `globals`, `openpgp`, `prettier`. Run `npm outdated` then bump with `npm update` or `npm install <pkg>@latest`. Verify with `npm test && npm run lint`.

### Library inventory

| Library             | Where loaded        | Version                           | SRI |
| ------------------- | ------------------- | --------------------------------- | --- |
| OpenPGP.js          | `index.html:41`     | `openpgp@6.3.1`                   | yes |
| highlight.js CSS    | `index.html:47`     | `highlightjs/cdn-release@11.11.1` | yes |
| highlight.js JS     | `index.html:52`     | `highlightjs/cdn-release@11.11.1` | yes |
| CodeMirror 5 (core) | `index.html:58-131` | `codemirror@5.65.21`              | yes |
| Marked              | `index.html:135`    | `marked@18.0.5`                   | yes |
| DOMPurify           | `index.html:1354`   | `dompurify@3.4.11`                | no  |
| Prettier            | `app.js:657,660`    | `prettier@3` (major pin)          | no  |
| eslint              | devDependencies     | `^10.5.0`                         | —   |
| globals             | devDependencies     | `^17.7.0`                         | —   |
| openpgp             | devDependencies     | `^6.3.1`                          | —   |
| prettier            | devDependencies     | `^3`                              | —   |
