# PRD — MCTS Community Utility Billing

**Status:** living document · **Owner:** Mavrone81 · **Last updated:** 2026-06-14

A multilingual (English / 中文 / ไทย) web app for the MCTS townhouse community in
Thailand to bill residents for **water and gas** from meter readings and a
configurable formula. This document is the product source of truth; the
`README.md` files describe how to run and deploy, and `ops/VAPT-2026-06-05.md`
tracks security findings.

---

## 1. Problem & goal

The community bills water and gas per house, per period, from manual meter
readings, on paper slips. The goal is a shared, multi-user system where an admin
enters readings once and each owner sees and downloads their own invoices from
any device — replacing the paper workflow without changing how the numbers are
calculated or how the slips look.

**Non-goals (for now):** online payment collection, automatic meter integration,
accounting/GL export, multi-community tenancy.

## 2. Users & roles

- **Admin** — community manager. Manages houses, rates/formula, meter readings,
  invoices, owner approvals, and branding.
- **Owner** — resident. Self-registers against a house number, is approved by an
  admin, then views/downloads their own invoices only.

## 3. Core requirements

**Admin**
- Dashboard: house count, billed-this-period count, pending approvals, period revenue.
- Houses: add/edit/delete by cluster + house number.
- Rates & formula: unit rates, fixed fees, and an editable charge formula
  (vars `prev`, `curr`, `usage`, `rate`, `fixed`; funcs `min`, `max`, `round`),
  evaluated **server-side by a safe parser — never `eval`/`Function`**.
- Meter readings: per house, per period; previous reading auto-fills from the
  prior period's current (falling back to its previous); live charge preview.
- Invoices: filter by house + period; select and download as PDF.
- Approvals: confirm each owner registration matches a real house before first login.
- Settings: community logo (also favicon), name, and address shown on invoices.

**Owner**
- Register with house number + username + password; pending until approved.
- Searchable list of own invoices; itemized statement; PDF download.

**Invoices / PDF**
- Per-utility printable slips (separate water and gas) modeled on the paper form:
  invoice number, name, house number, meter readings, units used, service charge,
  total, received-by signature line, date.
- Filenames: `HouseNumber_MM_YYYY` (e.g. `A-101_04_2026.pdf`).
- Invoice amounts and running invoice numbers are **authoritative on the server**;
  the client only renders them.

**Localization**
- Full EN / 中文 / ไทย UI. Thai uses Buddhist-era (B.E.) years and Thai-formatted
  dates everywhere, including the downloaded PDF.

## 4. Data-integrity contract (the core promise)

This is a billing ledger; silent data loss is the worst failure mode. The product
commits to:

1. **A recorded meter reading is never silently dropped.** In particular,
   *renaming/renumbering a house preserves its reading history.* The state sync
   keys houses by their stable server id, so a rename is an in-place update and the
   readings stay attached (R1, done). Deleting a house still cascades its readings,
   by design.
2. **An issued invoice is immutable.** Its amount and invoice number do not change
   after issue; corrections are new records, not edits.
3. **Concurrent admin edits do not silently clobber each other.** The client persists
   through per-resource REST endpoints with per-row optimistic concurrency: houses and
   readings carry a `rev`, settings a `state_version`. A save from a client holding a
   stale rev/version is rejected (HTTP 409) and the latest data is reloaded, instead of
   overwriting the newer change (R2 done). The legacy whole-state `PUT /state` is
   deprecated (kept as a backward-compatible, still version-guarded fallback).
4. **Money math is computed server-side** from stored readings/rates via the safe
   formula evaluator, and is reproducible for any past period.

## 5. Architecture (as built)

- **Client:** single-file web app served from `housecharging-server/public/index.html`
  (source of truth). A frozen localStorage-only prototype lives at repo-root
  `index.html` for demos.
- **Server:** Express + PostgreSQL. bcrypt passwords, JWT sessions (12h), admin/owner
  roles, parameterized SQL, DB-backed login lockout, security headers + CSP.
- **Admin persistence:** per-resource REST endpoints (`POST/PUT/DELETE /houses`,
  `POST /readings`, `PUT /settings`, `PUT /branding`) with per-row optimistic concurrency
  (`rev` / `state_version`). The legacy whole-state `PUT /api/admin/state` is deprecated but
  kept as a fallback. Owner accounts use dedicated register + approve/reject endpoints.
- **Deploy:** `docker compose` (app + Postgres) behind host nginx + Let's Encrypt at
  `mcts.urbanwerkzsg.com`; also a Render blueprint for UAT.

## 6. Security & ops posture

Source of truth: `ops/VAPT-2026-06-05.md` (2026-06-05 grey-box pentest — 0 Critical;
app core solid). In-app P1 findings are remediated: login rate-limiting (H-1),
security headers + CSP (M-1), non-root container (M-2), fail-closed JWT (L-7),
password min-length (L-1), framework-banner hidden (L-3), generic 5xx errors (L-6).
Tooling shipped for encryption-at-rest (M-3) and off-box encrypted backups (M-4).

**Gating bar — before loading real resident data:** rotate the admin password (H-2),
attach the DO Cloud Firewall (H-3), mount the encrypted volume (M-3), configure the
off-box backup cron (M-4), and confirm `JWT_SECRET` is a real random value.

## 7. Roadmap

Priority: P1 = before real resident data / wider rollout · P2 = soon · P3 = hygiene.

| # | Item | Pri | Status |
|---|------|-----|--------|
| R1 | House rename/renumber preserves reading history (data-integrity #1) | P1 | **done** — state sync keyed by stable house id |
| R2 | Per-resource REST persistence with per-row optimistic concurrency; full-state `PUT` deprecated | P2 | **done** |
| H-2 | Rotate admin password | P1 | **deferred (deliberate)** — ops |
| H-3 | Attach DO Cloud Firewall | P1 | **deferred (deliberate)** — ops |
| M-3 | Mount encrypted Postgres volume | P2 | **deferred (deliberate)** — tooling ready |
| M-4 | Configure off-box encrypted backup cron | P2 | tooling ready, config pending |
| M-5 | SSH hardening (`PermitRootLogin`, password auth) | P2 | ops |
| L-2 | Reduce username enumeration on register | P3 | open |
| L-5 | Validate house number on register (or keep approval gate as control) | P3 | open |
| L-4 | JWT revocation/refresh review | P3 | open |
| — | CI: integration test + `npm audit` on every push/PR | done | `.github/workflows/ci.yml` |

## 8. Decisions

These were open questions; resolved 2026-06-14 (confirm if any should change).

- **Owner visibility — own house only.** Owners never see community-wide totals or other
  houses; this matches the current data-isolation posture (VAPT confirmed no IDOR). An
  admin-only community dashboard already covers aggregate figures.
- **Payment recording — in scope for v1 (already built).** The admin can mark a month
  paid/unpaid and attach a proof-of-payment image; a PromptPay QR is shown to owners, who
  can view their own proof. Backed by `readings.paid/paid_at/payment_proof` and the
  `/api/admin/readings/:id/payment` + `/proof` endpoints. Online payment *collection*
  remains a non-goal (§1).
- **Retention.** Readings and invoices are kept **indefinitely** (immutable billing ledger,
  per §4). Backups: **14 days** local (`mcts-db-backup.sh`) and **30 days** off-box
  (`mcts-db-offsite.sh`, `REMOTE_RETENTION_DAYS`). ⚠️ Confirm against Thai tax-record law
  (accounting records often must be retained ~5 years) before relying on these windows for
  compliance — they are operational defaults, not a legal retention policy.

## 9. Open questions

- Legal/tax retention period for billing records in Thailand (drives backup retention above).
- Multi-admin support beyond the current optimistic-concurrency guard (roles, audit log)?
