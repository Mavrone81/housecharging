#!/usr/bin/env bash
# Nightly logical backup of the MCTS billing Postgres DB.
# Writes a gzipped pg_dump to /root/housecharging/backups and keeps 14 days.
set -euo pipefail

PROJECT_DIR=/root/housecharging/housecharging-server
OUT=/root/housecharging/backups
RETENTION_DAYS=14

mkdir -p "$OUT"
chmod 700 "$OUT"
cd "$PROJECT_DIR"

TS=$(date +%Y%m%d-%H%M%S)
TMP="$OUT/.mcts-$TS.sql.gz.partial"
FINAL="$OUT/mcts-$TS.sql.gz"

# Dump from the running db container, gzip, write atomically (rename only on success).
if docker compose exec -T db pg_dump -U mcts -d mcts --no-owner --clean --if-exists | gzip > "$TMP"; then
  mv "$TMP" "$FINAL"
  chmod 600 "$FINAL"
  echo "$(date -Is) OK  $FINAL ($(du -h "$FINAL" | cut -f1))"
else
  rm -f "$TMP"
  echo "$(date -Is) FAIL backup failed" >&2
  exit 1
fi

# Rotate: delete backups older than retention window.
find "$OUT" -name 'mcts-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete
