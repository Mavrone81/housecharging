# Operations notes (production: mcts.urbanwerkzsg.com)

Deployment-specific facts that aren't obvious from the application code. The app
itself is documented in the top-level `README.md`.

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

1. **Create + attach** a Block Storage volume to the droplet (DO panel → Volumes,
   same region sgp1). DO gives a stable device path like
   `/dev/disk/by-id/scsi-0DO_Volume_mcts-pgdata`.
2. **Format + mount** it (one-time), and persist in `/etc/fstab`:

       mkfs.ext4 /dev/disk/by-id/scsi-0DO_Volume_mcts-pgdata
       mkdir -p /mnt/mcts-pgdata
       echo '/dev/disk/by-id/scsi-0DO_Volume_mcts-pgdata /mnt/mcts-pgdata ext4 defaults,nofail,discard 0 2' >> /etc/fstab
       mount -a

3. **Take a backup first** (so the migration is reversible):

       /usr/local/bin/mcts-db-backup.sh

4. **Move the data** from the current Docker volume onto the encrypted mount:

       docker compose stop app db
       docker run --rm -v housecharging-server_pgdata:/from -v /mnt/mcts-pgdata:/to \
         alpine sh -c 'cp -a /from/. /to/'

   (Confirm the source volume name with `docker volume ls`.)
5. **Point compose at the mount:** in `docker-compose.yml`, uncomment the
   `driver_opts` bind under `volumes: pgdata:` (device `/mnt/mcts-pgdata`).
6. **Bring it back up and verify:**

       docker compose up -d
       docker compose exec db pg_isready -U mcts
       # spot-check the app and a known invoice, then remove the old volume:
       # docker volume rm housecharging-server_pgdata

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

> Note: backups currently sit on the same disk as the database. For real durability,
> copy them off-box (e.g. object storage) and consider encrypting the dump files.
