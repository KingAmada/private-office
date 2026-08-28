# Private Office Security Model

Private Office is intentionally Drive-first and static-first.

## Secrets

The public GitHub Pages code may contain only public configuration such as a Google OAuth Web Client ID and the AI gateway URL. It must never contain the OpenAI API key, a Google client secret, vault master password, Drive access token or Google ID token.

The OpenAI key lives only as an encrypted secret in the serverless gateway environment.

## Google Drive

Drive access tokens are held in browser memory. Private Office requests read-only access to existing Drive content plus `drive.file` write access for app-created/explicitly opened files. Existing files are not automatically moved.

Private Office persists its index in an app-created Drive JSON file so the catalog follows the user's Google account without an application database.

## AI boundary

The serverless gateway verifies the signed Google identity token and optionally checks the account against `ALLOWED_EMAILS`. Document copies sent for AI classification are temporary. Password-vault data is never sent to the AI gateway.

## Vault

The vault is encrypted before upload using AES-256-GCM with a key derived in-browser from the user's master password using PBKDF2-SHA-256. The master password and derived key are not persisted by the app.

Do not store one-time codes, CVVs, crypto seed phrases, recovery phrases or private keys in Private Office.
