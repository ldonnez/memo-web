# Memo Web

**▶️ [App available here](https://ldonnez.github.io/memo-web)**

Client-side web app for managing GPG-encrypted markdown notes stored in a private GitHub repository. Works as a PWA on iOS and desktop.

---

<a href="https://github.com/ldonnez/memo-web.github.io/actions"><img src="https://github.com/ldonnez/memo-web.github.io/actions/workflows/ci.yml/badge.svg?branch=main" alt="Build Status"></a>
<a href="https://github.com/ldonnez/memo-web.github.io?tab=MIT-1-ov-file#readme"><img src="https://img.shields.io/github/license/ldonnez/memo-web.github.io" alt="License"></a>

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

## PWA

When hosted on HTTPS, the app registers a Service Worker that:

- **Precaches** all local assets and CDN libraries for offline use
- **Caches** GitHub API responses (network-first, falls back to cache)
- **Auto-updates** — when a new version is detected, a banner appears asking
  the user to reload

To install on iOS, tap **Share → Add to Home Screen**. On desktop, look for the
install icon in the address bar.

## Run locally

```sh
npm run dev      # dev server at http://localhost:8080
npm test         # 49 unit tests (crypto round-trip, util, UI helpers)
npm run lint     # ESLint
npm run format   # Prettier
```

> **Why a dev server?** The app uses ES modules (`<script type="module">`) and
> a Service Worker, which require HTTP and don't work when opening `index.html`
> directly via `file://`. Any static server works — `npx serve .`,
> `python3 -m http.server`, etc.
