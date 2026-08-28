# Private Office — 10 minute local setup

## You need
- Node.js 20+
- A Google Cloud project with Drive API enabled
- Google OAuth Web Application credentials
- An OpenAI API key

## Commands

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Put the first generated value in `SESSION_SECRET` and the second in `APP_ENCRYPTION_KEY`.

Then fill in:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
OPENAI_API_KEY=...
```

In Google Cloud, add this redirect URI:

```text
http://localhost:3000/auth/google/callback
```

Then:

```bash
npm install
npm start
```

Open `http://localhost:3000`, sign in with the Google account whose Drive should become the Private Office, then use **Add anything** or **Index Drive**.
