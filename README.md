# Goblet — Frontend (Public Repo)

Single-page web application for client-side file encryption and decryption using the [Goblet Worker](../backend/README.md).

---

## Features

- 🔒 **Encrypt** any file (≤25 MB) → download a `.gob` container
- 🔓 **Decrypt** any `.gob` → restore original file
- 🎯 **Auto-detect mode** — drag a plain file → encrypt; drag a `.gob` → decrypt
- 🔑 **AES-256-GCM** encryption via Web Crypto API
- 🧅 **PBKDF2 + server pepper** key derivation (no crypto choices exposed to user)
- ✅ **Self-verification** — ciphertext is immediately verified before download
- 📱 **Responsive** dark glassmorphism UI
- ♿ **Accessible** — ARIA roles, live regions, keyboard navigable

---

## Quick Start (Local Dev)

### 1. Start the Goblet Worker locally
```bash
cd ../backend
# Set up .dev.vars with a SECRET_PEPPER value first
wrangler dev
# Worker runs at http://localhost:8787
```

### 2. Serve the frontend
Use any static file server. Examples:

**VS Code Live Server** (recommended):
- Install the "Live Server" extension
- Right-click `index.html` → "Open with Live Server"
- Runs on `http://127.0.0.1:5500` by default

**Python:**
```bash
python -m http.server 5500
```

**Node http-server:**
```bash
npx http-server -p 5500
```

### 3. Open in browser
Navigate to `http://127.0.0.1:5500` — the app will appear.

> The Worker runs on `http://localhost:8787` by default (set in `js/config.js`).

---

## File Structure

```
frontend/
├── index.html        — Single-page app shell
├── css/
│   └── style.css     — Dark glassmorphism stylesheet
├── js/
│   ├── config.js     — Worker URL + constants
│   ├── container.js  — .gob format builder/parser + base64 helpers
│   ├── crypto.js     — Web Crypto wrappers (derive key, AES-256-GCM)
│   └── app.js        — UI state machine + event handlers
└── assets/           — Static assets (icons, etc.)
```

---

## Configuration

Edit `js/config.js` before deploying:

```js
const config = {
  WORKER_URL: 'https://goblet-worker.yourname.workers.dev', // ← production
  MAX_FILE_SIZE: 25 * 1024 * 1024,  // 25 MB
  KDF_ITERATIONS: 200_000,
  SALT_BYTES: 16,
  IV_BYTES: 12,
};
```

---

## Deployment (Cloudflare Pages)

1. Push this folder as a GitHub repo
2. In Cloudflare Pages dashboard → "Create project" → connect repo
3. Build settings: **no build command**, output directory: `/` (root)
4. After deploy, copy your Pages URL (e.g. `https://goblet.pages.dev`)
5. Update `WORKER_URL` in `js/config.js` to your production Worker URL
6. Update `ALLOWED_ORIGINS` in `../backend/wrangler.toml` to include your Pages URL

---

## Deployment (GitHub Pages)

1. Push this folder contents to a GitHub repo (or `/docs` subfolder)
2. Enable GitHub Pages in repo Settings → Pages → `main` branch
3. Update `WORKER_URL` in `js/config.js`
4. Ensure the Cloudflare Worker `ALLOWED_ORIGINS` includes `https://yourusername.github.io`

---

## .gob Format (v1)

```json
{
  "version": 1,
  "timestamp": "2026-07-16T12:34:56.000Z",
  "originalName": "secret.pdf",
  "salt": "<base64-16-bytes>",
  "iv": "<base64-12-bytes>",
  "ciphertext": "<base64-AES-GCM-output-with-auth-tag>",
  "kdf": "PBKDF2",
  "kdfParams": { "hash": "SHA-256", "iterations": 200000 },
  "cipher": "AES-GCM-256"
}
```

---

## Browser Support

| Browser | Minimum Version |
|---------|----------------|
| Chrome  | 37+ |
| Firefox | 34+ |
| Safari  | 11+ (iOS 11+) |
| Edge    | 14+ |

Requires: `window.crypto.subtle` (Web Cryptography API)

---

## Security Notes

- Files are **never uploaded** anywhere — encryption/decryption happens entirely in the browser
- The password is sent to the Worker **over HTTPS** only for key derivation — never stored
- The server pepper is **never included** in the `.gob` container
- Wrong password → AES-GCM authentication tag fails → immediate error, no partial decryption
- Self-verification after encryption ensures the `.gob` is always valid before download
