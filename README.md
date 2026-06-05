# House Charging — MCTS Community Utility Billing

A multilingual (English / 中文 / ไทย) web app for a townhouse community in Thailand to manage
water and gas utility billing based on meter readings and a configurable formula.

This is a self-contained prototype: a single `index.html` file with no build step and no server.
Data is stored in the browser (localStorage), so it persists on the device it runs on.

## Quick start

Open `index.html` in any modern browser (Chrome or Edge recommended for PDF download).

You can also host it for free with **GitHub Pages**: in the repo go to
*Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / root*.
The app will be served at `https://mavrone81.github.io/housecharging/`.

## Demo logins

| Role  | Username | Password   |
|-------|----------|------------|
| Admin | `admin`  | `admin123` |
| Owner | `owner1` | `owner123` |

There is also a pending owner registration (`newbuyer`) waiting in the admin **Approvals** tab.

## Features

**Admin**
- Dashboard with houses, billed-this-period count, pending approvals, and period revenue.
- Houses: add/edit/delete townhouses by cluster and house number.
- Rates & Formula: set unit rates and fixed fees, and edit the charge formula directly
  (variables `prev`, `curr`, `usage`, `rate`, `fixed`; functions `min`, `max`, `round`) with
  live validation and a sandboxed evaluator.
- Meter Readings: enter readings per house per period; the previous reading auto-fills from last
  month's current (and falls back to last month's previous if that is blank); instant charge preview.
- Invoices: filter by house (dropdown) and period; select invoices and download as PDF.
- Approvals: confirm that each owner registration matches a real house before first login.
- Settings: upload a community logo (also used as the browser favicon) and set the community
  name and address shown on invoices.

**Owner**
- Register with house-number ownership, pending admin approval on first login.
- Searchable list of personal invoices; view an itemized statement; download as PDF.

**Invoices / PDF**
- Per-utility printable slips (separate water and gas), modeled on the community's paper form:
  invoice number, name, house number, meter readings, units used, service charge, total,
  received-by signature line, and date.
- Filenames follow `HouseNumber_MM_YYYY` (e.g. `A-101_04_2026.pdf`).

**Localization**
- Full English / Mandarin / Thai UI.
- Thai language displays Buddhist-era (B.E.) years and Thai-formatted dates throughout,
  including the downloaded PDF (e.g. 30 พ.ค. 2569).

## Roadmap (production)

The prototype keeps data in the browser. The intended production build is **Node + PostgreSQL**
with real authentication and roles, server-side formula evaluation (not `new Function`),
and server-generated PDFs for emailing/archiving. See the issue tracker for the plan.

## License

Private project for MCTS. All rights reserved.
