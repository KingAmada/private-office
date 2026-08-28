# Private Office

**Everything, remembered.**

Private Office is a white-theme, chat-first personal document and asset assistant designed to run as a **static GitHub Pages app**.

There is **no Node/Express backend and no application database server**.

## Architecture

```text
GitHub Pages (HTML/CSS/JS)
        |
        +---- Google Identity Services
        |          |
        |          +---- Google Drive API (directly from browser)
        |                   |
        |                   +---- Private Office / Inbox
        |                   +---- Private Office / Properties
        |                   +---- Private Office / Companies
        |                   +---- Private Office / .system/private-office-index.json
        |                   +---- Private Office / .system/private-office-vault.enc.json
        |
        +---- Serverless AI Gateway
                   |
                   +---- OpenAI Responses API
```

Google Drive is both the **document store and persistent Private Office memory**. New uploads go to Drive first. The browser sends a temporary copy to the AI gateway for classification, then files created by Private Office can be moved into the correct Drive folder. Existing Drive files are indexed without being rearranged.

The AI gateway exists for one reason: **an OpenAI API key must never be put into browser-side code**. It can be a Cloudflare Worker or another serverless edge function. The repository includes a Worker implementation in `worker/index.js`.

## Files

- `index.html` — application shell
- `styles.css` — white luxury interface
- `app.js` — Google login, Drive organization, local retrieval, encrypted vault and UI
- `config.js` — public runtime configuration (Google client ID + AI gateway URL only)
- `worker/index.js` — tiny serverless OpenAI gateway; no Node server
- `manifest.webmanifest` + `sw.js` — installable PWA shell
- `.github/workflows/pages.yml` — GitHub Pages deployment

## 1. Google Cloud setup

Create a Google Cloud project and enable the **Google Drive API**.

Create an **OAuth 2.0 Client ID** for a Web application. Add your GitHub Pages origin, for example:

```text
https://kingamada.github.io
```

If you later use a custom domain, add that HTTPS origin too.

Private Office requests these user scopes in the browser:

- `openid email profile`
- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/drive.file`

This intentionally gives read access to existing Drive files while limiting write access to app-created/explicitly opened files.

Put the public OAuth Client ID into `config.js`:

```js
GOOGLE_CLIENT_ID: '123456789-abc.apps.googleusercontent.com'
```

OAuth client IDs are public identifiers. **Do not put a Google client secret in this repo or in the browser.**

## 2. Deploy the AI gateway

The included `worker/index.js` is written for a serverless Web/Worker runtime and does not require Express or a Node server.

Create a Worker and add these encrypted environment variables/secrets in the provider dashboard:

```text
OPENAI_API_KEY=...
GOOGLE_CLIENT_ID=the_same_google_oauth_client_id
ALLOWED_EMAILS=brother@example.com
APP_ORIGINS=https://kingamada.github.io
OPENAI_MODEL=gpt-5.6-luna
```

`ALLOWED_EMAILS` can contain multiple comma-separated Google addresses. This is strongly recommended because it prevents another Google user from using your AI gateway even if they discover its URL.

The Worker verifies the Google ID token cryptographically against Google's signing keys before it calls OpenAI.

Then put the Worker URL in `config.js`:

```js
AI_GATEWAY_URL: 'https://private-office-ai.example.workers.dev'
```

## 3. GitHub Pages

The included workflow uploads the repository root as a GitHub Pages artifact. In the repository:

1. Open **Settings → Pages**.
2. Set **Source** to **GitHub Actions**.
3. Push to `main` (the workflow also runs manually).

For this repository the expected URL will normally be:

```text
https://kingamada.github.io/private-office/
```

If that is the final URL, the Google OAuth **Authorized JavaScript origin** is still:

```text
https://kingamada.github.io
```

and the Worker `APP_ORIGINS` value should use the same origin.

## What happens when a file is uploaded

1. Browser uploads the original directly to `Private Office / Inbox` in the user's Google Drive.
2. A temporary file copy is sent to the serverless AI gateway.
3. The gateway sends that temporary copy to OpenAI for classification and deletes the OpenAI file after the request.
4. Private Office extracts document type, category, useful dates, entity relationships and searchable summary.
5. High-confidence new uploads are moved into the relevant app-created Drive folder.
6. Low-confidence or prohibited-sensitive classifications stay in Inbox / Needs Review.
7. The structured record is written into `.system/private-office-index.json` in Drive.

## Existing Drive

**Index Drive** reads a small batch of supported existing files, classifies them and adds them to the Drive-based index. It does **not** move existing files.

Supported existing-file scanning currently includes common uploaded files plus Google Docs, Sheets and Slides through Drive export. Very large or unsupported files are skipped rather than guessed.

## Private Vault

Passwords never go through OpenAI.

The vault is encrypted in the browser using Web Crypto before it is written to Drive. The master password is not stored in GitHub, Google Drive or the AI gateway.

Current cryptography:

- PBKDF2-SHA-256, 310,000 iterations
- random 128-bit salt
- AES-256-GCM
- new random IV on every vault save

The decrypted vault exists only in browser memory while unlocked.

Do not use the vault for OTPs, CVVs, seed phrases, recovery phrases or private keys. Use a purpose-built hardware/password security solution for those classes of secrets.

## Security rules

- Never commit `OPENAI_API_KEY`.
- Never put an OpenAI API key in `config.js`.
- Never commit Google client secrets.
- Restrict the AI Worker using `ALLOWED_EMAILS`.
- Restrict CORS using `APP_ORIGINS`.
- Use HTTPS only.
- Keep the GitHub repository private if you want the source itself private; the architecture does not depend on source secrecy.

## Development

Because it is a static application, you can inspect it with any static HTTP server. Google Identity Services requires an authorized origin; `file://` is not suitable for the real OAuth flow.

No `npm install`, `node server.js`, Docker container, SQLite database, Express session, or backend server is required.
