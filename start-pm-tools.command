#!/bin/zsh
set -e

PROJECT_DIR="/Users/james/Document/Projects/PM-Tools"
PORT="${PORT:-5173}"
URL="http://127.0.0.1:${PORT}"

cd "$PROJECT_DIR"

echo "Starting PM Tools..."
echo "Project: $PROJECT_DIR"
echo "URL:     $URL"
echo

open "$URL" >/dev/null 2>&1 || true

PORT="$PORT" npm start
