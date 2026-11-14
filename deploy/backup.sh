#!/bin/sh
# Copies the catalog database out of the running server container.
# Usage: ./backup.sh [destination folder]     (default: ./backups)
# The copy is made with SQLite's own backup, so it is consistent even while the server runs.
set -eu
DEST="${1:-./backups}"
mkdir -p "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
docker compose exec -T server node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/data/agenteca.sqlite', { readonly: true });
  db.backup('/data/backup.sqlite').then(() => db.close());
"
docker compose cp server:/data/backup.sqlite "$DEST/agenteca-$STAMP.sqlite"
docker compose exec -T server rm -f /data/backup.sqlite
echo "Saved $DEST/agenteca-$STAMP.sqlite"
