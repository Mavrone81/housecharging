#!/usr/bin/env bash
# Off-box, encrypted backup of the MCTS billing DB (VAPT M-4).
#
# The nightly mcts-db-backup.sh keeps gzipped dumps ON THE SAME DISK as the
# database, so a disk/droplet loss takes both. This script ships a dump OFF the
# box to S3-compatible object storage (DigitalOcean Spaces / AWS S3), encrypted
# first with `age` so the stored copy is useless without the private key.
#
# Security model: encryption uses an `age` PUBLIC key (AGE_RECIPIENT). The
# droplet can ENCRYPT but holds no key to DECRYPT — keep the matching private
# key OFFLINE (password manager / offline host). A host compromise therefore
# cannot read past offsite backups.
#
# Run AFTER mcts-db-backup.sh (it uploads that script's newest dump), or pass a
# specific dump path as $1. Schedule a few minutes after the nightly backup, e.g.
#   35 3 * * * /usr/local/bin/mcts-db-offsite.sh >> /var/log/mcts-offsite.log 2>&1
#
# Required env (e.g. in /etc/mcts-offsite.env, chmod 600, sourced by cron):
#   AGE_RECIPIENT   age public key, "age1..." (recipient to encrypt to)
#   S3_BUCKET       destination, e.g. s3://mcts-backups/db
# Optional env:
#   S3_ENDPOINT     S3-compatible endpoint (DO Spaces: https://sgp1.digitaloceanspaces.com)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION  (aws CLI auth)
#   LOCAL_BACKUP_DIR  where mcts-db-backup.sh writes (default /root/housecharging/backups)
#   REMOTE_RETENTION_DAYS  prune remote objects older than this (default 30; 0 = never)
set -euo pipefail

LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-/root/housecharging/backups}"
REMOTE_RETENTION_DAYS="${REMOTE_RETENTION_DAYS:-30}"

: "${AGE_RECIPIENT:?set AGE_RECIPIENT to an age public key (age1...)}"
: "${S3_BUCKET:?set S3_BUCKET, e.g. s3://mcts-backups/db}"

command -v age >/dev/null || { echo "age not installed (apt-get install age)" >&2; exit 1; }
command -v aws >/dev/null || { echo "aws CLI not installed" >&2; exit 1; }

# aws CLI takes --endpoint-url for non-AWS S3 (e.g. DO Spaces); empty = real AWS.
aws_s3() {
  if [ -n "${S3_ENDPOINT:-}" ]; then aws --endpoint-url "$S3_ENDPOINT" s3 "$@"; else aws s3 "$@"; fi
}

# Pick the dump to ship: explicit arg, else the newest local dump.
SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC=$(ls -1t "$LOCAL_BACKUP_DIR"/mcts-*.sql.gz 2>/dev/null | head -n1 || true)
fi
[ -n "$SRC" ] && [ -f "$SRC" ] || { echo "$(date -Is) FAIL no dump found in $LOCAL_BACKUP_DIR (run mcts-db-backup.sh first)" >&2; exit 1; }

# Encrypt to a temp file, then upload atomically named after the source.
ENC="${SRC}.age"
TMP="${ENC}.partial"
trap 'rm -f "$TMP"' EXIT

age -r "$AGE_RECIPIENT" -o "$TMP" "$SRC"
mv "$TMP" "$ENC"
chmod 600 "$ENC"

DEST="${S3_BUCKET%/}/$(basename "$ENC")"
if aws_s3 cp "$ENC" "$DEST"; then
  echo "$(date -Is) OK  uploaded $DEST ($(du -h "$ENC" | cut -f1))"
else
  echo "$(date -Is) FAIL upload of $DEST failed" >&2
  exit 1
fi

# Prune old remote objects (best-effort; never fails the run).
if [ "$REMOTE_RETENTION_DAYS" -gt 0 ]; then
  cutoff=$(date -u -d "${REMOTE_RETENTION_DAYS} days ago" +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo "")
  if [ -n "$cutoff" ]; then
    aws_s3 ls "${S3_BUCKET%/}/" 2>/dev/null | awk '{print $1"T"$2" "$4}' | while read -r ts name; do
      [ -n "$name" ] || continue
      [[ "$ts" < "$cutoff" ]] && aws_s3 rm "${S3_BUCKET%/}/$name" >/dev/null 2>&1 && echo "  pruned $name" || true
    done
  fi
fi
