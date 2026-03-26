#!/bin/sh
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ ! -d node_modules ]; then
  npm install --silent
fi
exec node --no-warnings src/server.js
