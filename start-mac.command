#!/bin/bash
set -e
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Add your Google OAuth and OpenAI credentials, then run this file again."
  open -e .env 2>/dev/null || true
  exit 0
fi
if [ ! -d node_modules ]; then
  npm install
fi
npm start
