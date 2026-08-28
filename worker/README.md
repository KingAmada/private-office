# Private Office Worker

This Worker is the private API for the GitHub Pages PWA.

Bindings are declared in `../wrangler.jsonc`:

- `DB` → D1 `private-office-db`
- `FILES` → R2 `private-office`

Runtime secrets:

- `OPENAI_API_KEY` — OpenAI API key
- `SETUP_KEY` — temporary one-time owner bootstrap key

The Worker automatically initializes its D1 tables on first request. R2 public access should stay disabled.

Users authenticate with Private Office invitation/device-session tokens, not Google OAuth.
