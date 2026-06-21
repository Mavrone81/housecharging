#!/usr/bin/env bash
#
# auto-deploy-housecharging.sh — ZERO-DOWNTIME server-side pull deploy for the
# MCTS billing app (mcts.urbanwerkzsg.com). Compose project: housecharging-server
# (/root/housecharging/housecharging-server/docker-compose.yml).
#
# Runs every minute from root's crontab under flock. On a new, CI-passed commit
# it does a blue/green flip:
#   1. git reset --hard origin/main   (code only; .env + pgdata untouched)
#   2. build + start the IDLE color   (app-blue :3010 / app-green :3011)
#   3. health-check the idle color directly — abort & keep the active color if it
#      never goes healthy (so a bad build never takes the site down)
#   4. flip the host-nginx upstream include to the idle port, `nginx -t`, reload
#      (graceful: in-flight requests finish; the other apps on this box are
#      unaffected). On `nginx -t` failure we revert the include and abort.
#   5. stop the now-old color.
# No request is ever dropped: traffic only moves to a verified-healthy new color.
#
# Idempotency / self-healing: the LAST SUCCESSFULLY FLIPPED sha is recorded in
# $STATE_FILE. We compare origin/main against that — NOT against git HEAD — so if
# any step fails after the reset, the next run retries (HEAD already moved, but
# the flip never completed, so the state file still holds the old sha).
#
# Safety: never runs `compose down`, `down -v`, or `volume rm`. `.env` is
# git-ignored (survives reset); the db service uses postgres:16-alpine and is
# never rebuilt; pgdata named volume is never touched. nginx edits are limited to
# THIS app's include file and are validated before every reload (fail-closed).
#
# CI gate: deploy only proceeds once GitHub Actions pushed refs/ci-pass/<sha> for
# the exact target commit (.github/workflows/ci.yml). Read over the git protocol
# (public repo → no creds, no REST rate limit). Red build → no marker → we wait.
#
# Canonical copy lives in the repo at deploy/auto-deploy-housecharging.sh; the
# INSTALLED copy is /root/auto-deploy-housecharging.sh (the cron runs the
# installed copy — re-copy it after changing this file).
#
set -uo pipefail
# cron has a minimal PATH; docker/git/nginx/flock/curl live in /usr/bin|/usr/sbin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

REPO=/root/housecharging
COMPOSE_FILE="$REPO/housecharging-server/docker-compose.yml"
BRANCH=main
NGINX_UPSTREAM_INC=/etc/nginx/snippets/housecharging-active-upstream.conf
STATE_FILE=/root/.housecharging-deployed-sha
BLUE_PORT=3010; BLUE_SVC=app-blue
GREEN_PORT=3011; GREEN_SVC=app-green
DRAIN_SECONDS=8          # let nginx's old workers finish in-flight/keepalive conns before stopping the old color
TAG="[housecharging-deploy]"
ts() { date '+%F %T'; }

cd "$REPO" || { echo "$(ts) $TAG ERROR: cannot cd $REPO"; exit 1; }

# 1) Fetch and compare against the last SUCCESSFULLY DEPLOYED sha --------------
if ! git fetch --quiet origin "$BRANCH"; then
  echo "$(ts) $TAG ERROR: git fetch failed"; exit 1
fi
REMOTE=$(git rev-parse "origin/$BRANCH")
LAST_DEPLOYED=$(cat "$STATE_FILE" 2>/dev/null || true)
[ "$LAST_DEPLOYED" = "$REMOTE" ] && exit 0   # nothing new since last good deploy — quiet

SHORT_LAST=${LAST_DEPLOYED:-none}; SHORT_LAST=${SHORT_LAST:0:7}
echo "$(ts) $TAG target ${REMOTE:0:7} (last deployed $SHORT_LAST)"

# 1b) CI gate: require a CI-pass marker for the exact target commit -----------
if git ls-remote origin "refs/ci-pass/$REMOTE" 2>/dev/null | grep -q "$REMOTE"; then
  echo "$(ts) $TAG CI-pass marker present for ${REMOTE:0:7} — deploying"
else
  echo "$(ts) $TAG no CI-pass marker for ${REMOTE:0:7} yet — will retry next run"; exit 0
fi

# 2) Determine ACTIVE vs IDLE color from the live nginx include ---------------
ACTIVE_PORT=$(grep -oE '301[01]' "$NGINX_UPSTREAM_INC" 2>/dev/null | head -1)
case "$ACTIVE_PORT" in
  "$BLUE_PORT")  ACTIVE_SVC=$BLUE_SVC;  IDLE_SVC=$GREEN_SVC; IDLE_PORT=$GREEN_PORT; IDLE_COLOR=green ;;
  "$GREEN_PORT") ACTIVE_SVC=$GREEN_SVC; IDLE_SVC=$BLUE_SVC;  IDLE_PORT=$BLUE_PORT;  IDLE_COLOR=blue  ;;
  *) echo "$(ts) $TAG ERROR: cannot read active port from $NGINX_UPSTREAM_INC (got '${ACTIVE_PORT:-<empty>}') — aborting"; exit 1 ;;
esac
echo "$(ts) $TAG active=$ACTIVE_SVC(:$ACTIVE_PORT) -> deploying idle=$IDLE_SVC(:$IDLE_PORT)"

# 3) Advance code (code only; .env is git-ignored and survives) ---------------
if ! git reset --hard "$REMOTE"; then
  echo "$(ts) $TAG ERROR: git reset failed — aborting (active color still serving)"; exit 1
fi
echo "$(ts) $TAG changed files this deploy:"
git --no-pager diff --name-only "${LAST_DEPLOYED:-$REMOTE}" "$REMOTE" 2>/dev/null | sed 's/^/    /'

# 4) Build + start the IDLE color (active color keeps serving) ----------------
if ! docker compose -f "$COMPOSE_FILE" up -d --build "$IDLE_SVC"; then
  echo "$(ts) $TAG ERROR: build/start of $IDLE_SVC failed — stopping it, active color untouched"
  docker compose -f "$COMPOSE_FILE" stop "$IDLE_SVC" >/dev/null 2>&1
  exit 1
fi

# 5) Health-gate the idle color on its OWN port before any traffic flip -------
code=000
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$IDLE_PORT/" 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 2
done
if [ "$code" != "200" ]; then
  echo "$(ts) $TAG ERROR: $IDLE_SVC unhealthy (last HTTP $code) — NOT flipping; stopping idle. Active still serving."
  docker compose -f "$COMPOSE_FILE" logs --tail=20 "$IDLE_SVC" 2>&1 | sed 's/^/    /'
  docker compose -f "$COMPOSE_FILE" stop "$IDLE_SVC" >/dev/null 2>&1
  exit 1
fi
echo "$(ts) $TAG $IDLE_SVC healthy (HTTP 200 on :$IDLE_PORT)"

# 6) Flip host nginx to the idle color — atomic write, validate, reload -------
printf 'server 127.0.0.1:%s;\n' "$IDLE_PORT" > "${NGINX_UPSTREAM_INC}.tmp"
mv "${NGINX_UPSTREAM_INC}.tmp" "$NGINX_UPSTREAM_INC"
if ! nginx -t >/dev/null 2>&1; then
  echo "$(ts) $TAG ERROR: nginx -t failed after flip — reverting include to :$ACTIVE_PORT, aborting"
  printf 'server 127.0.0.1:%s;\n' "$ACTIVE_PORT" > "$NGINX_UPSTREAM_INC"
  docker compose -f "$COMPOSE_FILE" stop "$IDLE_SVC" >/dev/null 2>&1
  exit 1
fi
if ! nginx -s reload 2>/dev/null; then
  echo "$(ts) $TAG WARNING: 'nginx -s reload' failed, trying systemctl reload nginx"
  systemctl reload nginx || { echo "$(ts) $TAG ERROR: nginx reload failed — reverting"; printf 'server 127.0.0.1:%s;\n' "$ACTIVE_PORT" > "$NGINX_UPSTREAM_INC"; nginx -s reload 2>/dev/null; docker compose -f "$COMPOSE_FILE" stop "$IDLE_SVC" >/dev/null 2>&1; exit 1; }
fi
echo "$(ts) $TAG nginx now routing mcts.urbanwerkzsg.com -> $IDLE_COLOR (:$IDLE_PORT)"

# 7) Record success. Drain, THEN stop the old color & prune dangling images ----
#    The drain delay lets nginx's pre-reload worker processes finish any in-flight
#    or keepalive connections still bound to the old port before we release it —
#    without it, stopping the old color can race a draining worker and 502 a
#    single request.
echo "$REMOTE" > "$STATE_FILE"
sleep "$DRAIN_SECONDS"
docker compose -f "$COMPOSE_FILE" stop "$ACTIVE_SVC" >/dev/null 2>&1
echo "$(ts) $TAG drained ${DRAIN_SECONDS}s, stopped old color $ACTIVE_SVC(:$ACTIVE_PORT)"
docker image prune -f >/dev/null 2>&1

# 8) Final end-to-end health check through nginx ------------------------------
pub=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$IDLE_PORT/" 2>/dev/null || echo 000)
echo "$(ts) $TAG done — now serving ${IDLE_COLOR} at ${REMOTE:0:7} (health HTTP $pub)"
exit 0
