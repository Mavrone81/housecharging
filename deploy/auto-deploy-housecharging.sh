#!/usr/bin/env bash
#
# auto-deploy-housecharging.sh — server-side pull deploy for the MCTS billing app
# (mcts.urbanwerkzsg.com). Compose project: housecharging-server
# (/root/housecharging/housecharging-server/docker-compose.yml, services db/app).
#
# Runs every minute from root's crontab under flock. If origin/main has a new
# commit AND that commit has a CI-pass marker, it fast-forwards the working tree
# and rebuilds ONLY this app's `app` container. The 9 other compose projects on
# this shared host (ims, medusa, bevora, mandamix, urbanwerkz, web, ...) are
# never touched: every docker command is pinned to THIS compose file, which
# scopes it to the `housecharging-server` project.
#
# Persistent state is safe:
#   * .env (DB password, JWT secret, admin creds) is git-ignored, so
#     `git reset --hard` never overwrites it.
#   * The database lives in the named volume housecharging-server_pgdata;
#     `up -d --build` never touches volumes. The db service uses the upstream
#     postgres:16-alpine image and is never rebuilt or recreated here.
# This script NEVER runs `compose down`, `down -v`, or `volume rm`.
#
# CI gate: the deploy only proceeds once GitHub Actions has pushed
# refs/ci-pass/<sha> for the exact target commit (.github/workflows/ci.yml).
# We read that ONE ref over the git protocol (public repo → no creds, no REST
# rate limit). A red build simply never produces a marker, so we wait & retry.
#
# Canonical copy lives in the repo at deploy/auto-deploy-housecharging.sh; the
# INSTALLED copy is /root/auto-deploy-housecharging.sh (re-copy manually if you
# change this file — the cron runs the installed copy).
#
set -uo pipefail
# cron has a minimal PATH; docker/git/flock live in /usr/bin on this host.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

REPO=/root/housecharging
COMPOSE_FILE="$REPO/housecharging-server/docker-compose.yml"
SERVICES="app"                 # only the locally-built service; db is a registry image
BRANCH=main
HEALTH_URL="http://127.0.0.1:3010/"
TAG="[housecharging-deploy]"
ts() { date '+%F %T'; }

cd "$REPO" || { echo "$(ts) $TAG ERROR: cannot cd $REPO"; exit 1; }

# 1) Fetch and compare --------------------------------------------------------
if ! git fetch --quiet origin "$BRANCH"; then
  echo "$(ts) $TAG ERROR: git fetch failed"; exit 1
fi
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")
[ "$LOCAL" = "$REMOTE" ] && exit 0   # up to date — stay quiet (runs every minute)

echo "$(ts) $TAG new commit ${LOCAL:0:7} -> ${REMOTE:0:7}"
echo "$(ts) $TAG changed files:"
git --no-pager diff --name-only "$LOCAL" "$REMOTE" | sed 's/^/    /'

# 1b) CI gate: require a CI-pass marker for the exact target commit -----------
if git ls-remote origin "refs/ci-pass/$REMOTE" 2>/dev/null | grep -q "$REMOTE"; then
  echo "$(ts) $TAG CI-pass marker present for ${REMOTE:0:7} — deploying"
else
  echo "$(ts) $TAG no CI-pass marker for ${REMOTE:0:7} yet — will retry next run"; exit 0
fi

# 2) Advance code (code only; .env is git-ignored and survives) ---------------
if ! git reset --hard "$REMOTE"; then
  echo "$(ts) $TAG ERROR: git reset failed — aborting (containers untouched)"; exit 1
fi

# 3) Rebuild + restart, scoped to the housecharging-server compose project ----
#    Recreates only `app` when its image changes; db keeps running and pgdata is
#    untouched. Migrations run on app boot (idempotent: src/migrate.js).
# shellcheck disable=SC2086
docker compose -f "$COMPOSE_FILE" up -d --build $SERVICES
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "$(ts) $TAG ERROR: rebuild exited rc=$RC (previous containers kept running)"
  exit "$RC"
fi

# 4) Disk hygiene: drop dangling images only ----------------------------------
docker image prune -f >/dev/null 2>&1

# 5) Post-deploy health check (informational — the new container is already up)
code=000
for i in 1 2 3 4 5; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 3
done
if [ "$code" = "200" ]; then
  echo "$(ts) $TAG health OK (HTTP 200)"
else
  echo "$(ts) $TAG WARNING: health check returned HTTP $code — investigate (recent app logs below)"
  docker compose -f "$COMPOSE_FILE" logs --tail=20 app 2>&1 | sed 's/^/    /'
fi

echo "$(ts) $TAG done rc=$RC, now at $(git rev-parse --short HEAD)"
exit 0
