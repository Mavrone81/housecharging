#!/usr/bin/env bash
#
# Migrate the MCTS Postgres data directory onto an encrypted DigitalOcean Block
# Storage volume (VAPT M-3). Run ON THE DROPLET as root, AFTER you have created
# and attached the volume in the DO panel.
#
#   sudo ops/mcts-encrypt-volume.sh <device> [mountpoint]
#   sudo ops/mcts-encrypt-volume.sh /dev/disk/by-id/scsi-0DO_Volume_mcts-pgdata /mnt/mcts-pgdata
#
# Safe by design: it takes a fresh backup first, COPIES (never moves) the data,
# switches docker-compose to a bind mount on the encrypted disk, and health-checks
# Postgres before finishing. The original Docker named volume is left intact so you
# can roll back; remove it only once you're confident.
set -euo pipefail

DEVICE="${1:-}"
MOUNT="${2:-/mnt/mcts-pgdata}"

die() { echo "ERROR: $*" >&2; exit 1; }
confirm() { local a; read -rp "$1 [y/N] " a; [ "$a" = y ] || [ "$a" = Y ] || die "aborted"; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)."
[ -n "$DEVICE" ] || die "usage: $0 <device> [mountpoint]"
[ -b "$DEVICE" ] || die "block device not found: $DEVICE — attach the volume in the DO panel first."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yml"
[ -f "$COMPOSE_FILE" ] || die "docker-compose.yml not found at $COMPOSE_FILE"
cd "$COMPOSE_DIR"

if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi

echo "Device:      $DEVICE"
echo "Mount point: $MOUNT"
echo "Compose:     $COMPOSE_FILE"
echo "Compose cmd: $DC"
confirm "Proceed with the encrypted-volume migration?"

# 1. Filesystem (only format a blank device).
if ! blkid "$DEVICE" >/dev/null 2>&1; then
  confirm "No filesystem on $DEVICE — create ext4 now? (this destroys any data on the device)"
  mkfs.ext4 "$DEVICE"
fi

# 2. Mount + persist in /etc/fstab.
mkdir -p "$MOUNT"
mountpoint -q "$MOUNT" || mount "$DEVICE" "$MOUNT"
if ! grep -qs "[[:space:]]$MOUNT[[:space:]]" /etc/fstab; then
  echo "$DEVICE $MOUNT ext4 defaults,nofail,discard 0 2" >> /etc/fstab
  echo "Added $MOUNT to /etc/fstab."
fi

# 3. Fresh backup before touching the data.
if [ -x /usr/local/bin/mcts-db-backup.sh ]; then
  echo "Taking a pre-migration backup..."
  /usr/local/bin/mcts-db-backup.sh
else
  echo "WARNING: /usr/local/bin/mcts-db-backup.sh not found — cannot auto-backup."
  confirm "Continue WITHOUT a fresh backup?"
fi

# 4. Find the Postgres named volume.
VOL="$(docker volume ls --format '{{.Name}}' | grep -E 'pgdata$' | head -1 || true)"
[ -n "$VOL" ] || die "could not find the pgdata Docker volume (check 'docker volume ls')."
echo "Source volume: $VOL"

# 5. Stop the stack — the DB must be down while we copy its files.
$DC stop

# 6. Copy data onto the encrypted mount (skip if it already holds a data dir).
if [ -f "$MOUNT/PG_VERSION" ]; then
  echo "$MOUNT already contains a Postgres data dir (PG_VERSION present) — skipping copy."
else
  echo "Copying data: volume $VOL -> $MOUNT ..."
  docker run --rm -v "$VOL":/from -v "$MOUNT":/to alpine sh -c 'cp -a /from/. /to/'
fi
[ -f "$MOUNT/PG_VERSION" ] || die "copy verification failed: $MOUNT/PG_VERSION is missing."
echo "Copy verified (PG_VERSION present)."

# 7. Switch docker-compose to the bind mount (back the file up first).
BACKUP="$COMPOSE_FILE.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$COMPOSE_FILE" "$BACKUP"
echo "Backed up compose to $BACKUP"
python3 - "$COMPOSE_FILE" "$MOUNT" <<'PY'
import sys
f, mount = sys.argv[1], sys.argv[2]
s = open(f).read()
active = "      - pgdata:/var/lib/postgresql/data"
bind_comment = "      # - /mnt/mcts-pgdata:/var/lib/postgresql/data"
bind = "      - %s:/var/lib/postgresql/data" % mount
if bind in s:
    print("compose already uses the bind mount — no change")
elif active in s and bind_comment in s:
    s = s.replace(active, "      # - pgdata:/var/lib/postgresql/data  # disabled for M-3 (encrypted bind mount)")
    s = s.replace(bind_comment, bind)
    open(f, "w").write(s)
    print("compose updated to bind-mount %s" % mount)
else:
    sys.exit("could not find the expected volume lines in docker-compose.yml — edit it by hand")
PY
grep -q "      - $MOUNT:/var/lib/postgresql/data" "$COMPOSE_FILE" \
  || { cp -a "$BACKUP" "$COMPOSE_FILE"; die "compose edit did not apply — restored from backup."; }

# 8. Bring it back up and health-check before declaring success.
$DC up -d
echo "Waiting for Postgres to become ready..."
ok=
for _ in $(seq 1 30); do
  if $DC exec -T db pg_isready -U mcts >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" = 1 ] || die "Postgres did not become ready. Check '$DC logs db'. Rollback: 'cp $BACKUP $COMPOSE_FILE && $DC up -d'."
echo "Postgres is healthy on the encrypted volume."
$DC exec -T db psql -U mcts -d mcts -c "select count(*) AS houses FROM houses;" || true

cat <<EOF

Done — Postgres now runs on the encrypted volume at $MOUNT.

Next:
  1. Verify the app end-to-end (log in, open a known invoice).
  2. Only once confident, remove the old unencrypted volume:
       docker volume rm $VOL

Rollback (if anything is wrong):
       cp $BACKUP $COMPOSE_FILE
       $DC up -d
EOF
