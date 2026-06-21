# Operations notes (production: mcts.urbanwerkzsg.com)

Deployment-specific facts that aren't obvious from the application code. The app
itself is documented in the top-level `README.md`.

## CI/CD & zero-downtime deploys
Push to `main` → GitHub Actions runs the test matrix + `npm audit`, then the
`ci-pass-marker` job pushes `refs/ci-pass/<sha>` (built-in token, no secrets). A
per-minute root cron runs `/root/auto-deploy-housecharging.sh` under `flock`
(canonical copy: `deploy/auto-deploy-housecharging.sh` — re-copy to `/root/` after
editing; the cron runs the installed copy).

The deploy is **blue/green** for zero downtime:
- Two app colors are defined in compose: `app-blue` (:3010) and `app-green` (:3011).
  Only one serves at a time.
- host nginx proxies `mcts.urbanwerkzsg.com` to `upstream housecharging_app`, whose
  member is the single line in `/etc/nginx/snippets/housecharging-active-upstream.conf`
  (`server 127.0.0.1:3010;` or `:3011;`).
- On a new CI-passed commit the script: `git reset --hard origin/main` → build &
  start the **idle** color → health-check it on its own port → rewrite the include to
  the idle port → `nginx -t` → `nginx -s reload` (graceful) → stop the old color.
- No request is dropped: traffic only moves to a verified-healthy new color. If the
  build or health check fails, the active color keeps serving and the next run
  retries (the last *successfully flipped* sha is tracked in
  `/root/.housecharging-deployed-sha`, not git HEAD).
- Never runs `compose down`/`down -v`/`volume rm`; `.env` and the `pgdata` volume are
  never touched; the db service is never rebuilt.

To roll back: revert the commit on `main` (auto-deploys), or manually flip the
include back and `nginx -s reload` + start the previous color.

## Runtime
- Runs via `docker compose` on a DigitalOcean droplet (region sgp1).
- App container is published to **127.0.0.1:3010** only; host **nginx** reverse-proxies
  `https://mcts.urbanwerkzsg.com` → `127.0.0.1:3010` (TLS via Let's Encrypt/Certbot).
- Postgres is **not** published to the host/internet — the app reaches it over the
  internal compose network only.
- nginx `client_max_body_size` is raised to 12m (matches the app's JSON body limit)
  so logo / PromptPay QR / proof-of-payment images can be uploaded.
- Secrets (`POSTGRES_PASSWORD`, `JWT_SECRET`, `ADMIN_PASSWORD`) live in a gitignored
  `.env`; compose substitutes them and fails fast if unset.

## Security headers (VAPT M-1 / L-3)
The app sets the security response headers itself (CSP, HSTS, `X-Frame-Options`,
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`) and disables the
`X-Powered-By` banner — see `src/app.js`. nginx passes these through unchanged.

Two things must still be done at the nginx layer (it owns these, the app can't):

1. **Hide the nginx version banner (L-3):** in the `http {}` block of
   `/etc/nginx/nginx.conf`:

       server_tokens off;

2. **(Optional) Move HSTS to the TLS edge.** The app already sends HSTS, so this is
   only needed if you'd rather own it at nginx. If you do, add it to the `server {}`
   block and it's fine to leave the app's copy (browsers tolerate one value):

       add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

Apply with `nginx -t && systemctl reload nginx`. Verify end-to-end:

    curl -sI https://mcts.urbanwerkzsg.com | grep -iE 'content-security|strict-transport|x-frame|x-content|referrer|permissions|server|x-powered'

## Non-root container (VAPT M-2)
The app image runs as the unprivileged `node` user (`USER node` in the Dockerfile)
and both services set `security_opt: [no-new-privileges:true]` in compose. Verify
after deploy:

    docker compose exec app id        # expect uid=1000(node), not uid=0(root)

## Encryption at rest (VAPT M-3)
Goal: put the Postgres data directory on a **DigitalOcean Block Storage** volume,
which DO encrypts at rest, instead of the unencrypted droplet root disk.

**Step 1 (manual, DO panel):** create a Block Storage volume in region **sgp1** and
**attach** it to the droplet. DO gives a stable device path like
`/dev/disk/by-id/scsi-0DO_Volume_mcts-pgdata`.

**Step 2 (automated):** run the migration helper from the repo root on the droplet:

    sudo ops/mcts-encrypt-volume.sh /dev/disk/by-id/scsi-0DO_Volume_mcts-pgdata /mnt/mcts-pgdata

The script does the rest safely and reversibly:
- formats the device (only if blank) and mounts it at `/mnt/mcts-pgdata` (+ `/etc/fstab`);
- takes a **fresh backup** via `mcts-db-backup.sh`;
- stops the stack and **copies** (never moves) the Postgres data dir onto the volume,
  verifying `PG_VERSION` landed;
- switches `docker-compose.yml` to the bind mount (backing the file up to
  `docker-compose.yml.bak.<timestamp>` first);
- brings the stack back up and **health-checks** Postgres before declaring success.

The original Docker named volume is **kept** for rollback. Only after you've verified
the app end-to-end should you remove it:

    docker volume rm <old-pgdata-volume>   # the script prints the exact name

**Rollback** (if Postgres doesn't come up): restore the compose backup and restart —

    cp docker-compose.yml.bak.<timestamp> docker-compose.yml && docker compose up -d

> Why a bind mount (not `driver_opts`): an existing Docker **named** volume won't adopt
> new `driver_opts`, so that change silently wouldn't take effect. A bind mount on the
> service always uses the host path as-is.
>
> Note: this encrypts the **live database** disk. Backups are covered separately
> (M-4 — ship them off-box and encrypt the dumps).

## Host firewall — lock down the droplet (VAPT H-3)
The droplet has **no firewall** (`ufw` inactive, iptables `INPUT` policy `ACCEPT`)
and exposes many services to the internet on `0.0.0.0`:
`22, 80, 443, 3000, 3002, 4000-4013, 4998`. The 3000 / 4000-series / 4998 ports are
*other* applications (HRMS, urbanwerkz, vorkhive) sharing the same box as the MCTS
database — so a compromise of any one of them is a pivot to the billing data. Only
`80` and `443` (nginx) and `22` (SSH, ideally restricted) need to face the internet.

Use a **DigitalOcean Cloud Firewall** (recommended — it sits in front of the droplet,
so a misconfig can't lock you out at the OS level and it survives reboots/rebuilds).

### Pre-flight — will this break the other apps? (run BEFORE attaching)
A Cloud Firewall filters only traffic arriving **from outside** the droplet. nginx keeps
`80`/`443` open and forwards to each app over **loopback** (`proxy_pass http://127.0.0.1:<port>`),
and loopback/on-box traffic never crosses the firewall. So any app reached **through nginx
on 443 is unaffected** — you're only removing the *redundant direct* internet exposure of the
raw ports. The **only** thing that breaks is an app someone reaches **directly on its port**
(e.g. `http://<ip>:4001`) rather than via `https://…`. Confirm which case applies first:

    # 1. Every domain nginx serves and where it proxies (the source of truth)
    sudo nginx -T 2>/dev/null | grep -E 'server_name|listen |proxy_pass'

    # 2. What's listening, and on which interface (0.0.0.0 = public, 127.0.0.1 = local-only)
    sudo ss -tlnp

    # 3. From your LAPTOP (off the droplet): does any raw port answer directly?
    nmap -Pn -p 22,80,443,3000,3002,4000-4013,4998 <droplet-ip>

Decision rule:
- Each app has a `server_name` on 443 and a `proxy_pass` to `127.0.0.1:<port>` → **safe**, the
  firewall changes nothing for users.
- An app binds `0.0.0.0:<port>` but is only used via nginx → **safe** (and the firewall closes
  exactly the exposure H-3 flags).
- A port is genuinely hit directly from outside (a user, integration, or webhook) → **add an
  inbound allow rule** for just that port (source-restricted if possible) in Option A, instead
  of leaving it open to everyone.

### Safe rollout / rollback
A Cloud Firewall is applied at the hypervisor and is **instantly reversible**: create it →
attach to the droplet → immediately test (a) each app's public URL and (b) your own SSH. If
anything misbehaves, **detach** it from the droplet and you're back to the prior state with no
OS-level changes — then add the missing allow rule and re-attach. Keep a DO **web console**
session open during the first attach as an SSH fallback.

### Option A — DigitalOcean Cloud Firewall (recommended)
1. DO panel → **Networking → Firewalls → Create Firewall**.
2. **Inbound rules** (everything else is denied by default):
   - `HTTP`  TCP `80`  — sources: `All IPv4, All IPv6`
   - `HTTPS` TCP `443` — sources: `All IPv4, All IPv6`
   - `SSH`   TCP `22`  — sources: **your admin IP(s) only** (e.g. office/VPN). Avoid
     leaving 22 open to the world; `fail2ban` is active but source-restriction is better.
3. **Outbound rules:** leave the defaults (allow all) unless you have a reason to limit.
4. **Apply to Droplet:** attach the firewall to this droplet (or a tag it carries).
5. The `3000 / 3002 / 4000-4013 / 4998` ports are simply **not** in the allow-list, so
   they stop being internet-reachable the moment the firewall is attached.

> Note: a DO Cloud Firewall **overrides** what's bound on `0.0.0.0`; you don't have to
> change each sibling app. But step B is still worth doing as defense-in-depth.

### Option B — also bind internal services to localhost (defense-in-depth)
For any service that only nginx (or another local process) needs to reach, bind it to
`127.0.0.1` instead of `0.0.0.0` so it isn't exposed even without a firewall. For the
MCTS app this is already done (`127.0.0.1:3010` in `docker-compose.yml`). Audit the
sibling apps' compose/service configs the same way.

### Option C — host firewall with ufw (if you can't use a Cloud Firewall)
Set the SSH rule **first** so you don't lock yourself out, then enable:

    ufw allow from <YOUR_ADMIN_IP> to any port 22 proto tcp
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw --force enable
    ufw status verbose

> Warning: enabling ufw over an SSH session without the port-22 allow rule will drop
> your connection. Add the SSH rule first and keep a DO web console session open as a
> fallback.

### Verify (from off the droplet)
    nmap -Pn -p 22,80,443,3000,3002,4000-4013,4998 <droplet-ip>
    # expect: 80/443 open; 3000/3002/4000-4013/4998 filtered; 22 filtered except from your IP

## Backups
`mcts-db-backup.sh` takes a gzipped `pg_dump`, written atomically, keeping 14 days.
Deployed copy lives at `/usr/local/bin/mcts-db-backup.sh`, scheduled nightly via cron:

    30 3 * * * /usr/local/bin/mcts-db-backup.sh >> /var/log/mcts-backup.log 2>&1

Backups are written to `/root/housecharging/backups`.

Run an on-demand backup:

    /usr/local/bin/mcts-db-backup.sh

Restore a backup (DANGER: overwrites current data — uses --clean --if-exists dumps):

    zcat /root/housecharging/backups/mcts-YYYYMMDD-HHMMSS.sql.gz \
      | docker compose exec -T db psql -U mcts -d mcts

## Off-box encrypted backups (VAPT M-4)
The nightly dump above lives on the **same disk** as the database, so a disk/droplet
loss takes both. `mcts-db-offsite.sh` ships it **off the box** to S3-compatible object
storage (DO Spaces / S3), **encrypted with `age` first**.

Security model: encryption uses an `age` **public** key. The droplet can encrypt but
holds no key to decrypt — keep the matching **private key offline**. So even a full host
compromise can't read the offsite copies.

One-time setup on the droplet:

    apt-get install -y age awscli                 # tools
    age-keygen -o key.txt                          # do this OFFLINE; note the "Public key:" line
    # put the PRIVATE key (key.txt) in a password manager / offline host, NOT on the droplet
    cat >/etc/mcts-offsite.env <<'EOF'             # then chmod 600
    AGE_RECIPIENT=age1...your-public-key...
    S3_BUCKET=s3://mcts-backups/db
    S3_ENDPOINT=https://sgp1.digitaloceanspaces.com
    AWS_ACCESS_KEY_ID=...
    AWS_SECRET_ACCESS_KEY=...
    AWS_DEFAULT_REGION=sgp1
    EOF
    chmod 600 /etc/mcts-offsite.env

Schedule it a few minutes after the nightly backup so it ships that fresh dump:

    35 3 * * * . /etc/mcts-offsite.env && /usr/local/bin/mcts-db-offsite.sh >> /var/log/mcts-offsite.log 2>&1

Restore (on any machine with the **private** key):

    aws --endpoint-url "$S3_ENDPOINT" s3 cp s3://mcts-backups/db/mcts-YYYYMMDD-HHMMSS.sql.gz.age .
    age -d -i key.txt mcts-YYYYMMDD-HHMMSS.sql.gz.age | zcat \
      | docker compose exec -T db psql -U mcts -d mcts   # DANGER: overwrites current data
