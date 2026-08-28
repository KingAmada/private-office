# Security boundaries

Private Office is designed around separation of concerns.

## Never exposed to browser source
- OpenAI API key
- Google OAuth client secret
- Google OAuth refresh tokens
- Application encryption key

## Stored in Google Drive
- Original uploaded documents
- Existing user documents remain where they already are

## Stored in the local database
- Document metadata and AI-generated safe search text
- Embeddings
- Entity relationships
- Encrypted OAuth session token bundle
- Encrypted password-vault ciphertext

## Not intentionally indexed
- Passwords found inside uploaded documents
- OTPs
- CVVs
- Card or transaction PINs
- Crypto seed/recovery phrases
- Private keys

## Trust assumptions
The machine or server hosting the Node process can access decrypted document metadata during normal operation. Protect that host with full-disk encryption, OS updates, least-privilege accounts, firewalling and secure backups.

A public/commercial release should add CSRF defenses, malware scanning, audit logs, passkeys/WebAuthn, stronger multi-user authorization boundaries and a formal security review.
