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
