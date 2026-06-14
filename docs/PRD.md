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
   *renaming/renumbering a house must preserve its reading history.* Today the
   client treats a rename as delete-old + add-new, which **drops that house's
   readings** — this is a known defect (see Roadmap R1), to be fixed before the
   community grows, and avoided in the interim (rename in the DB directly).
2. **An issued invoice is immutable.** Its amount and invoice number do not change
   after issue; corrections are new records, not edits.
3. **Concurrent admin edits do not silently clobber each other.** The current
   `PUT /api/admin/state` full-state sync is last-write-wins and assumes a single
   admin in a single tab (Roadmap R2).
4. **Money math is computed server-side** from stored readings/rates via the safe
   formula evaluator, and is reproducible for any past period.

## 5. Architecture (as built)

- **Client:** single-file web app served from `housecharging-server/public/index.html`
  (source of truth). A frozen localStorage-only prototype lives at repo-root
  `index.html` for demos.
- **Server:** Express + PostgreSQL. bcrypt passwords, JWT sessions (12h), admin/owner
  roles, parameterized SQL, DB-backed login lockout, security headers + CSP.
- **Admin persistence:** debounced `PUT /api/admin/state` (full houses/readings/settings
  snapshot). Owner accounts use dedicated register + approve/reject endpoints and are
  never overwritten by the state sync.
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
| R1 | House rename/renumber preserves reading history (data-integrity #1) | P1 | open |
| R2 | Move admin edits to per-resource REST endpoints with per-row optimistic concurrency; retire full-state `PUT` | P2 | open |
| H-2 | Rotate admin password | P1 | ops (runbook ready) |
| H-3 | Attach DO Cloud Firewall | P1 | ops (runbook ready) |
| M-3 | Mount encrypted Postgres volume | P2 | tooling ready, attach pending |
| M-4 | Configure off-box encrypted backup cron | P2 | tooling ready, config pending |
| M-5 | SSH hardening (`PermitRootLogin`, password auth) | P2 | ops |
| L-2 | Reduce username enumeration on register | P3 | open |
| L-5 | Validate house number on register (or keep approval gate as control) | P3 | open |
| L-4 | JWT revocation/refresh review | P3 | open |
| — | CI: integration test + `npm audit` on every push/PR | done | `.github/workflows/ci.yml` |

## 8. Open questions

- Should owners ever see community-wide totals, or strictly their own house?
- Is payment recording (mark-as-paid, PromptPay proof) in scope for v1, or view-only?
- Retention policy for readings/invoices and for off-box backups?
