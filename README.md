# Private Office

**Everything, remembered.**

Private Office is a mobile-first shared personal-office memory. Trusted people can open a private invitation link, send a message, upload a document/photo, and leave. Private Office remembers the conversation and the original file so the owner can retrieve it conversationally later.

There is **no Google sign-in, no Google Drive dependency, no Node server, and no database server to maintain**.

## Architecture

```text
GitHub Pages PWA
      |
      +---- private invitation / remembered device session
      |
Cloudflare Worker
      |
      +---- D1: people, sessions, invitations, messages, file memory
      +---- R2: original private files
      +---- OpenAI: one-time document understanding + concise answers
```

## Access model

- **Owner** — full memory, files, chat, People & Access, revoke access.
- **Assistant** — full office memory and file/chat access, but cannot manage people.
- **Staff** — can upload/send messages and access their own submissions/replies.

The owner creates a separate private link for each trusted person. On first use the link is exchanged for a 90-day revocable device session stored in that browser. The invitation token is removed from the visible URL after acceptance.

## Storage

- R2 binding: `FILES` → bucket `private-office`
- D1 binding: `DB` → database `private-office-db`
- R2 public access should remain **disabled**. Files are returned only through the authenticated Worker.

D1 tables are created automatically by the Worker on first request.

## Required Cloudflare secret

Keep these only in **Worker Runtime Variables and Secrets**:

```text
OPENAI_API_KEY=...
SETUP_KEY=one-long-random-one-time-owner-setup-key
```

`SETUP_KEY` is only needed to bootstrap the first owner. Do not commit it to GitHub.

The non-secret deployment config is in `wrangler.jsonc` and includes the R2/D1 bindings, app origin, app URL and OpenAI model.

## First owner setup

1. Deploy the latest `main` commit to the Cloudflare Worker.
2. Add `SETUP_KEY` as a **runtime Secret**.
3. Open `https://kingamada.github.io/private-office/`.
4. Choose **Set up owner access**.
5. Enter your name and the one-time setup key.
6. Private Office creates the owner and stores a revocable device session locally.

After the owner exists, the setup endpoint refuses to create another owner.

## Sharing access

As owner, open **People** → enter the person's name → choose `Staff` or `Assistant` → **Create private link** → Copy.

The recipient simply opens the link. No Google account or sign-in is required.

## Memory behavior

- A text note is stored directly in D1 without an AI call.
- A question searches stored office memory and sends only a small relevant context to OpenAI.
- A new file is hashed, stored in R2, read by AI once for compact classification/summary/filename, then remembered in D1.
- Uploading the exact same file again reuses the existing file memory and avoids another document-AI read.
- OpenAI file copies are temporary and deleted after classification.

## Files

- `index.html` — mobile-first app shell
- `styles.css` — app UI
- `app.js` — invite/session, chat, uploads, library and People UI
- `config.js` — public Worker endpoint only
- `worker/index.js` — API and R2/file workflows
- `worker/db.js` — D1 schema, sessions and access helpers
- `worker/ai.js` — low-token OpenAI classification/answering
- `wrangler.jsonc` — Worker, R2 and D1 bindings
- `manifest.webmanifest` + `sw.js` — installable PWA
