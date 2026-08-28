# Private Office AI Gateway

This folder contains the only secret-bearing component of Private Office. It is a tiny serverless Worker, not a Node/Express backend.

Required Worker secrets/variables:

- `OPENAI_API_KEY` — secret
- `GOOGLE_CLIENT_ID` — same public Web Client ID used by the frontend
- `ALLOWED_EMAILS` — comma-separated Google accounts allowed to use the gateway
- `APP_ORIGINS` — comma-separated allowed frontend origins, e.g. `https://kingamada.github.io`
- `OPENAI_MODEL` — optional; defaults to `gpt-5.6-luna`

The Worker validates Google ID token signatures using Google's current public JWKS before accepting requests.
