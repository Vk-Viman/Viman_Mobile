# Implementation Status

| Phase | Scope | Status |
|---|---|---|
| **1** | Foundation: DB + migrations, settings, audit log, backup/restore, web shell, launcher, docs | **☑ Complete (2026-11-10) — awaiting owner approval for Phase 2** |
| 2–14 | See TASKS.md | not started |

## Phase 1 — what exists
- **Server** (`server/src`): Fastify on `127.0.0.1:4300`; SQLite via `node:sqlite` (WAL, foreign keys); migration runner with LF-normalised checksums; `001_foundation.sql` (`schema_migrations`, `settings`, `audit_logs`).
- **API** (`/api/v1`): `GET /health` · `GET/PUT /settings` (shop details, commission rates 600/80 bp, 7 print defaults) · `GET /audit-logs` (keyset paging) · `GET/POST /backups` · `POST /backups/restore` (by name or upload; typed `RESTORE`; 5 validation gates; safety backup; rollback on failure).
- **Money library**: integer cents, BigInt `mulDivRound` (half away from zero), basis points, `Rs. 12,345.00` formatting — ready for Phase 3+.
- **Web**: sidebar with all 13 sections (12 show "Available in Phase N"), Dashboard system-status card, Settings (General, Commission rates, Printing defaults, Backups, Audit log).
- **Launcher**: `Start-Viman-Shop.bat` (Node ≥ 24 check → already-running detection → `npm ci` if needed → rebuild if stale → server → opens browser when healthy).
- **Backups**: automatic at every start (after the port is secured), newest 30 kept; pre-restore safety copies newest 10.

## Verification evidence (2026-11-10)
- `npm test`: **11 files, 213 tests, all passing** (49 independent finance vectors + 164 QA) — after the final review.
- `npm run typecheck`: server + web clean. `npm run build`: success (JS 340 kB / 107 kB gzip, CSS 18 kB).
- **Cold start via `Start-Viman-Shop.bat`** with no `data/`: DB created, migrated to v1, startup backup written, health OK.
- **Browser (Playwright Chromium, 1366×768) at http://localhost:4300**: all 13 nav items; placeholder pages; deep-link SPA routing; General save → DB + audit row (before/after); rate `6.255` rejected client-side, `6.5` saved as 650 bp; Backup now; restore via dialog (button disabled until exactly `RESTORE`) → data reverted + safety backup; junk-file upload → "This file is not a Viman Mobile database. (RESTORE_INVALID_FILE)", data untouched; Esc closes dialog; audit tab lists all changes; restart via launcher → data persisted; rebuild while running → new assets served; **0 console errors**.
- Verification data was moved out of the project afterwards — the owner's first launch starts clean with default settings.

## Final review (2026-11-10)
- Fixed: power-cut durability (synchronous=FULL), DB-enforced append-only audit log (migration 002, schema v2), atomic restore swap, damaged-DB detection with read-only pre-flight + recovery instructions, crash temp-file cleanup, contract gaps. See AGENT_WORK_LOG.md FR-1…FR-7.
- **P-2 (electricity) approved and applied** across BUSINESS_RULES §7 (E1–E5), DATABASE_SCHEMA, API_CONTRACTS.
- **Final accounting rules approved 2026-11-10** (P-1 with D1–D4, P-2, and four confirmations); last Financial Logic consistency review: consistent after minor doc fixes. R-FD (no future-dated transactions; backdating allowed) approved and documented. R-RD (returns never dated before the original sale/purchase) approved and documented. Final documentation review: consistent; awaiting owner approval to start Phase 2.
- **P-1 (Ice Cream three-fund system) approved 2026-11-10 with D1–D4** and written into BUSINESS_RULES §10, DATABASE_SCHEMA (Phase 8–10 plans) and API_CONTRACTS (P8–P12). Implemented Phase 1 schema (v2) is unaffected; the fund tables arrive with Phases 8–10.
- Clean start re-verified via the launcher (schema v2, default 6% / 0.8%); verification data moved out of the project.

## Known limitations (Phase 1)
- No business features yet (products, sales, cash books, etc. arrive in Phases 2–14).
- Restore of a >200 MB upload and a true concurrent-restore 409 are not exercised by tests (the 503 guard is).
- The in-app Claude browser pane was hidden during verification; interactive checks ran in Playwright's Chromium against the same server.
- Launcher: if `node_modules` exists but is incomplete it does not self-repair (run `npm ci`); stale-build detection uses file timestamps of `web/src`, `index.html`, `vite.config.ts` only.
- Electricity / segment rules are documented (BUSINESS_RULES.md) but enforced only from Phase 8/10 when those tables exist.
