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
