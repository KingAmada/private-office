# Private Office Security Model

Private Office uses invitation-based access, Cloudflare D1 for memory/session metadata, and private Cloudflare R2 for original files.

## No public file storage

R2 public access should remain disabled. The browser never receives an R2 public URL. A file is returned only through the Worker after a valid Private Office session is checked.

## Invitations and sessions

Invitation tokens and device-session tokens are high-entropy random values. Only SHA-256 hashes are stored in D1. The plaintext device session stays in the recipient browser and can be revoked by the owner.

Create a separate link per person. Never share one staff link among several people. Revoking a person disables their sessions and invitation.

## Bootstrap secret

The first owner is created with the Worker runtime secret `SETUP_KEY`. Never commit this value to GitHub. Once an owner exists, the bootstrap endpoint refuses to create a second owner.

## OpenAI boundary

`OPENAI_API_KEY` remains a Cloudflare runtime Secret and is never sent to the browser. New file contents are sent to OpenAI only for temporary one-time document understanding; the uploaded OpenAI copy is deleted immediately after classification. The permanent original remains in R2.

Text notes do not require an AI call. Questions send only a small set of relevant stored memory to the model. Duplicate files are detected by SHA-256 and reuse existing file memory.

## Roles

- Owner: full office memory and access management.
- Assistant: full office memory, without People administration.
- Staff: their own submissions and Private Office replies only.

## Sensitive credentials

Private Office is intended for documents and office memory, not raw authentication secrets. Do not upload or store OTPs, CVVs, crypto seed phrases, recovery phrases, private keys or similar high-risk secrets.
