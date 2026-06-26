# Memo Web

Client-side web app for managing GPG-encrypted markdown notes stored in a private GitHub repository. Works as a PWA on iOS and desktop.

- 🔒 All encryption/decryption happens in-browser (OpenPGP.js) — server never sees plaintext
- 📦 Notes live in any GitHub repo via the Contents API
- 🔑 Symmetric (passphrase) or asymmetric (GPG key) encryption
- ✏️ Markdown editing with CodeMirror 5, live preview with syntax highlighting
- 📱 PWA — add to home screen, works offline, auto-updates on new version
- 🔐 Armored PGP format compatible with `gpg` CLI

## Security

**Only use this app on devices you trust.** Your GitHub token and encryption keys
are stored in `localStorage` and are accessible to any JavaScript running on the
page. While Content-Security-Policy restricts script sources, a compromised
device or browser extension could exfiltrate your credentials.

Attack surface:

- **GitHub PAT** — grants read/write access to your notes repository
- **GPG private key / passphrase** — allows decryption of all notes
- **localStorage** — credentials persist across sessions

The CSP restricts script sources, disallows `eval()`, and limits API calls to
GitHub only. No telemetry, no external requests beyond the configured repo.

## Usage

Host anywhere static (GitHub Pages, etc.) or run locally:

```sh
npm run dev      # dev server at http://localhost:8080
npm test         # 49 unit tests (crypto round-trip, util, UI helpers)
npm run lint     # ESLint
npm run format   # Prettier
```

Pass connection details via URL query params:

```
?owner=yourname&repo=your-notes&branch=main&path=notes/hello.md
```

> **Why a dev server?** The app uses ES modules (`<script type="module">`) and
> a Service Worker, which require HTTP and don't work when opening `index.html`
> directly via `file://`. Any static server works — `npx serve .`,
> `python3 -m http.server`, etc.

## PWA

When hosted on HTTPS, the app registers a Service Worker that:

- **Precaches** all local assets and CDN libraries for offline use
- **Caches** GitHub API responses (network-first, falls back to cache)
- **Auto-updates** — when a new version is detected, a banner appears asking
  the user to reload

To install on iOS, tap **Share → Add to Home Screen**. On desktop, look for the
install icon in the address bar.

## CI

| Step         | Status                                          |
| ------------ | ----------------------------------------------- |
| Lint         | `npm run lint` + `npm run format:check`         |
| Test         | `npm test` — 49 unit tests                      |
| Dependencies | Dependabot checks npm and GitHub Actions weekly |

## Tech

- [OpenPGP.js](https://openpgpjs.org/) v6 — browser-side crypto (armored PGP)
- [CodeMirror 5](https://codemirror.net/) — markdown editor with syntax highlighting
- [Marked](https://marked.js.org/) — markdown preview rendering
- [highlight.js](https://highlightjs.org/) — code block syntax highlighting
- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents) — read/write notes
