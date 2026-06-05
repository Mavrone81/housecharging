# MCTS Community Utility Billing — Node + PostgreSQL

Full-stack version of the billing app: an Express API backed by PostgreSQL, serving the
multilingual (EN / 中文 / ไทย) web client. Data is shared server-side, so an admin enters
readings once and every owner sees their own invoices from any device — the real
multi-user setup needed for UAT.

- Real accounts: bcrypt-hashed passwords, JWT sessions, admin/owner roles.
- Owners self-register and are **approved by an admin** before first login.
- **Server-side formula evaluator** (no `eval`/`Function`) — admin-entered formulas are
  parsed safely and cannot run code.
- Per-utility printable invoice slips with stable running invoice numbers.
- Thai shows Buddhist-era years and Thai dates throughout.

---

## 1. Run locally with Docker (recommended first step)

Requires Docker Desktop. From this folder:

```bash
docker compose up --build
```

This starts PostgreSQL, runs migrations, seeds an admin (and demo data, because
`SEED_DEMO=true` in compose), and serves the app at **http://localhost:3000**.

Demo logins: admin `admin` / `admin123`, owner `owner1` / `owner123` (house A-101).

## 2. Run locally without Docker

You need Node 18+ and a PostgreSQL database.

```bash
cp .env.example .env          # then edit DATABASE_URL, JWT_SECRET, ADMIN_PASSWORD
npm install
npm run migrate               # creates tables + seed admin (set SEED_DEMO=true for demo data)
npm start                     # http://localhost:3000
```

---

## 3. Deploy for UAT

The app is one web service + one PostgreSQL database. Any of these work; pick one.

### Option A — Render (simplest, has a free tier)

A `render.yaml` blueprint is included.

1. Push this project to a GitHub repo.
2. In Render: **New + → Blueprint**, select the repo. Render reads `render.yaml`, creates a
   free Postgres database and a web service, and links them automatically.
3. Set `ADMIN_PASSWORD` in the service's Environment tab (it's intentionally not in the file).
4. Deploy. The start command runs migrations automatically, then boots the server.
5. Your UAT URL is the Render service URL, e.g. `https://housecharging.onrender.com`.

Note: Render's free web service sleeps after inactivity and the free Postgres expires after
~30–90 days — fine for a time-boxed UAT, upgrade to a paid instance for anything longer.

### Option B — Railway

1. Push to GitHub. In Railway: **New Project → Deploy from GitHub repo**.
2. Add a **PostgreSQL** plugin; Railway sets `DATABASE_URL` for you.
3. In the service **Variables**, add `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`,
   and `PGSSL=true`.
4. Set the start command to `node src/migrate.js && node src/server.js`.
5. Deploy; use the generated public domain as your UAT URL.

### Option C — Any VPS / Docker host

Build the image (`Dockerfile` included) and run it with `DATABASE_URL` pointing at your
Postgres. Run `node src/migrate.js` once, then `node src/server.js` (or just use
`docker compose` on the server).

---

## Running the UAT

1. **Deploy** using one of the options above and confirm the URL loads the login screen.
2. **Log in as admin** and set things up: upload your logo and address in **Settings**, set
   **Rates & Formula**, add the real **Houses**, and enter a period of **Meter Readings**.
3. **Invite testers.** Give residents the URL and ask them to **Register** (house number +
   username + password). They'll be "pending".
4. **Approve** each tester in the admin **Approvals** tab (this is the ownership check).
5. Testers **log in** and view/download their invoices. Collect feedback.

Tip: keep the tester list small and give everyone the same period of data so results are
comparable. Because it's real shared data, what the admin enters is what testers see.

### Keeping the UAT private
The app requires login, but the URL is public. For a closed UAT you can additionally put it
behind **Cloudflare Access** (free, email-allowlist) or your host's password protection, and
use real (non-demo) passwords. Don't load real resident data until you've set strong
admin/owner passwords and `JWT_SECRET`.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (required). |
| `PGSSL` | `true` if your managed Postgres requires SSL (Render/Railway: yes). |
| `JWT_SECRET` | Long random string used to sign login tokens. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Seed admin account, created on first `migrate`. |
| `PORT` | Server port (most hosts set this automatically). |
| `CORS_ORIGINS` | Comma-separated allowed origins; blank = same-origin only (fine, since the client is served by this server). |
| `SEED_DEMO` | `true` to load demo houses/readings/owner on first migrate. Keep `false` for real use. |

## API overview

```
POST /api/auth/admin/login            POST /api/auth/owner/login
POST /api/auth/owner/register         GET  /api/branding            (public)
GET  /api/admin/bootstrap             PUT  /api/admin/state         (admin)
GET  /api/admin/invoices?house=&period=
GET  /api/admin/owners                POST /api/admin/owners/:id/approve|reject
GET  /api/owner/bootstrap             (owner — their invoices only)
GET  /api/health
```

## Notes & known limitations (pilot)

- The web client persists admin edits by sending the full houses/readings/settings state
  to `PUT /api/admin/state` (debounced). This is simple and robust for a single admin and a
  small community. Owner accounts are managed through dedicated, safe endpoints (register +
  approve/reject), never overwritten by the state sync.
- Renaming a house number in the client is treated as delete-old + add-new, which drops that
  house's old readings. Avoid renaming during the pilot, or do it directly in the database.
- Invoice amounts and numbers are authoritative on the server. The browser only renders them.
- For larger or longer-term use, move admin edits to the per-resource REST endpoints (already
  present for houses/readings/settings) and add per-row optimistic concurrency.

## License

Private project for MCTS. All rights reserved.
