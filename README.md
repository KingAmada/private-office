# Private Office AI

A private, white-theme personal records assistant that uses **Google Drive as the source of truth**, **OpenAI as the document intelligence/retrieval layer**, **SQLite as the private relationship/index layer**, and a **separately encrypted password vault**.

## What is real in this build

- Google OAuth login. The app never receives the user's Google password.
- Safer split Drive permissions by default:
  - `drive.readonly` to discover/read existing files.
  - `drive.file` to create and manage files created/opened through Private Office.
- New uploads go to Google Drive, are temporarily analyzed by OpenAI, classified with Structured Outputs, indexed semantically, and then organized.
- Confident **new** uploads are physically moved into `Private Office / <Category> / <Linked record>`.
- Low-confidence or forbidden-content uploads go to `Private Office / Needs Review`.
- Existing Drive files can be indexed in batches, but are **never physically moved by sync**. They are virtually organized in the Private Office metadata layer.
- Natural-language chat retrieves the most relevant indexed records and returns the exact Drive source links.
- Password vault uses scrypt-derived keys + AES-256-GCM. The vault password is not stored.
- OTPs, CVVs, PINs, seed phrases, recovery phrases and private keys are explicitly blocked from chat retrieval and vault storage.
- OAuth refresh tokens are encrypted before being written into the SQLite-backed session store.
- OpenAI API keys and Google OAuth client secrets stay on the server; none are exposed to browser JavaScript.

## Architecture

```text
Browser
  │
  ▼
Private Office Node/Express backend
  ├── Google OAuth 2.0
  ├── Google Drive API ───────► Original files / folders
  ├── OpenAI Responses API ──► Classification + grounded answers
  ├── OpenAI Embeddings ─────► Semantic retrieval vectors
  ├── SQLite ────────────────► Metadata, entities, vectors, sessions
  └── Encrypted Vault ──────► Password ciphertext only
```

The raw document remains in Google Drive. The private database stores the classification, relationship metadata, a compact searchable representation and embeddings. During classification, a temporary OpenAI `user_data` file is set to expire after one hour and the code also attempts to delete it immediately after the response. API responses use `store: false`.

## 1. Google Cloud setup

1. Go to Google Cloud Console and create/select a project.
2. Enable **Google Drive API**.
3. Configure the OAuth consent screen.
4. Create an **OAuth client ID → Web application**.
5. For local use, add this Authorized redirect URI exactly:

   `http://localhost:3000/auth/google/callback`

6. While the OAuth app is in testing, add the Google account that will use Private Office as a test user.
7. Copy the Client ID and Client Secret into `.env`.

For a deployed app, replace the localhost URL with the HTTPS production domain in both Google Cloud and `.env`.

> If this becomes a public/commercial product, Google may require OAuth verification because reading a user's Drive is a sensitive/restricted capability. Do not switch to full `drive` write scope unless the product actually requires it.

## 2. OpenAI setup

Create an OpenAI API key and place it in `.env`. The default model is configurable:

```env
OPENAI_MODEL=gpt-5.5
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

If your OpenAI project exposes a different supported model, change `OPENAI_MODEL`; the rest of the app does not depend on a hard-coded model ID.

## 3. Configure and run

```bash
cp .env.example .env
# edit .env
npm install
npm start
```

Open:

`http://localhost:3000`

Then click **Continue with Google**.

### Generate strong local secrets

You can generate two different secrets with:

```bash
openssl rand -hex 32
```

Use one as `SESSION_SECRET` and a different one as `APP_ENCRYPTION_KEY`.

## 4. Docker option

```bash
cp .env.example .env
# edit .env
docker compose up -d --build
```

The `data/` directory is mounted so the index and encrypted vault survive container restarts.

## How uploads work

1. User drops a file into Private Office.
2. Backend creates/fetches `Private Office / Inbox` in the authenticated user's Google Drive.
3. Original file is uploaded to Drive.
4. A temporary copy is sent to OpenAI for structured classification.
5. Private Office extracts document type, category, dates, parties, linked property/company/person, tags, sensitivity and a safe searchable representation.
6. High-confidence new uploads are moved into a suitable Private Office folder.
7. Low-confidence files stay in `Needs Review`.
8. Embeddings are generated from the safe search representation and stored locally for semantic retrieval.

## How existing Drive indexing works

Click **Index Drive**. Each run processes only a small batch (`MAX_SYNC_FILES_PER_RUN`) so one request does not attempt to ingest an entire lifetime of files at once.

Existing files are **read and virtually categorized only**. The app intentionally does not move or rename them. This makes the initial rollout much safer.

Google-native Docs, Sheets, Slides and Drawings are exported to PDF temporarily for document understanding. Unsupported or oversized files are skipped and reported.

## Password vault

The first time the user opens **Private Vault**, they create a separate vault password of at least 12 characters.

- The password itself is never saved.
- `scrypt` derives the encryption key.
- AES-256-GCM encrypts each stored password and note.
- Reveals require the vault password again.
- The browser automatically hides a revealed password after 60 seconds.

Do **not** use this vault for OTPs, CVVs, card/transaction PINs, crypto seed phrases, recovery phrases or private keys. The API blocks those categories deliberately.

For a commercial multi-user release, replace the simple vault unlock flow with passkeys/WebAuthn plus a professionally audited secrets architecture or dedicated password-manager integration.

## Important production hardening

This is a serious runnable foundation, not the final security audit. Before placing high-value personal records on a public internet server:

- Run only over HTTPS.
- Put the `data/` directory on an encrypted disk/volume.
- Keep `.env` outside source control and use a managed secrets store in production.
- Use a reverse proxy/WAF and IP/device restrictions if the user is comfortable with them.
- Add automated encrypted database backups.
- Add an audit log for sign-ins, uploads, Drive reads, vault reveals and administrative actions.
- Add CSRF protection for production state-changing routes.
- Add malware scanning before processing uploaded files.
- Use a dedicated production database such as PostgreSQL + pgvector if the index grows beyond a personal/small-office scale.
- Run a professional application-security review before storing extremely sensitive legal, financial or identity information.

## Key environment variables

See `.env.example`. Important ones include:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_DRIVE_SCOPES`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `SESSION_SECRET`
- `APP_ENCRYPTION_KEY`
- `AUTO_ORGANIZE_CONFIDENCE`
- `MAX_SYNC_FILES_PER_RUN`

## Why this design instead of "ChatGPT directly connected to Drive"?

The ChatGPT product can connect to Google Drive for work performed inside ChatGPT, but a standalone Private Office website needs its **own** OAuth authorization and server-side APIs. This project gives the website that independent authorization while still using OpenAI models for the intelligence layer.
