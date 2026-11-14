# Tasks

Status: ☑ done · ◐ in progress · ☐ not done. Phases 1 to 13 are built, tested and merged into `main` (last merge: pull request #10, Phase 12). Phase 14, the final validation and documentation review, is in progress. Details of how each phase was built and verified are in `IMPLEMENTATION_STATUS.md` and `AGENT_WORK_LOG.md`.

## Phase checklist

| # | Phase | Migration | Main screens | Status |
|---|---|---|---|---|
| 1 | Foundation: database and migrations, settings, audit log, backup and restore, web shell, launcher | 001, 002 | Settings, Backups, Audit log | ☑ |
| 2 | Catalog: categories (12 built-in), products, suppliers | 003 | Products | ☑ |
| 3 | Purchases, stock movements, inventory engine, cash ledger table | 004 | Purchases, stock history | ☑ |
| 4 | Stocktake, stock losses, personal use (goods drawings), valuation | 005 | Stock | ☑ |
| 5 | POS, sales, returns, voids; delete guards (007); editable sale cost / extra cost (008, rule C13) | 006, 007, 008 | Sales | ☑ |
| 6 | Telecom: reloads, EZCash, top-ups, provider rates | 009 | Telecom | ☑ |
| 7 | Printing: service types, print sales, supplies | 010 | Printing | ☑ |
| 8 | Expenses (no electricity), cash books, opening balances, cash counts, daily closings, `DAY_CLOSED`, Ice Cream fund ledger table | 012 | Expenses, Cash Books | ☑ |
| 9 | Cash transfers, cash drawings, capital | 013 | Drawings | ☑ |
| 10 | Ice Cream three-fund accounting (BUSINESS_RULES §10) | 014 | Ice Cream | ☑ |
| 11 | Financial and operational reports, Excel export | none | Reports | ☑ |
| 12 | Dashboard, charts, Excel export pack | none | Dashboard | ☑ |
| 13 | Opening stock: manual entry and Excel import | 011 | Opening Stock | ☑ |
| 14 | Integration, validation, documentation review, final report | none | — | ◐ |

## Phase 14 — validation checklist

- [x] Full server suite on the merged tree: 81 test files, 1,681 tests, all passing (re-run during the documentation review).
- [x] Documentation brought in line with the code: `README.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `API_CONTRACTS.md`, `server/src/db/migrations/README.md`; findings in `DOC_REVIEW_FINDINGS.md`.
- [ ] Owner decisions on the items in `DOC_REVIEW_FINDINGS.md` (proposed wording for `BUSINESS_RULES.md`).
- [ ] Combined browser pass through `Start-Viman-Shop.bat` on a clean database covering every screen (Waves 1 to 4 had agent-level browser checks only).
- [ ] Final report to the owner.

## Known limitations and future work

Each item below was checked in the code.

- **Settings → Printing defaults is a read-only reference.** `settings.printDefaults` is not read by any service; the tab now says so and links to Printing → Service types, where print prices and standard costs are managed (`print_service_types`, seeded once by migration 010). Owner may ask to remove the tab and the stored list entirely.
- **Service products cannot be sold in the POS.** A product with kind `service` is refused on a sale line (`PRODUCT_NOT_SELLABLE_YET`, message "Service products are not sold in the POS. Use Printing for print and photocopy jobs."). Printing and photocopying use their own tables; there is no other way to sell an "other service". Services can still be created in Products.
- **Two allowed values are never written:** cash entry type `expense_refund` and stock movement type `sale_void` (an expense void reverses the `expense` entry; a sale void reverses with type `sale`).
- **A database trigger abort that no service maps becomes `500 INTERNAL_ERROR`.** Services map the aborts they expect (future date, closed day, invalid date, return dates, stock limits, ...); an unexpected one such as `PRODUCT_BOOK_MISMATCH` is not translated.
- **No automated tests for the web app.** It is covered by typecheck, the production build and manual browser passes.
- **Single user, no login.** The server listens on `127.0.0.1` by default; `VIMAN_HOST` can expose it, but there is no authentication.
- **Launcher port.** `Start-Viman-Shop.bat` opens `http://localhost:4300` in its "already running" branch even if `VIMAN_PORT` differs, and the Vite dev proxy is fixed to port 4300.
- **Stock valuation for a past date can show negative quantity** when a loss was backdated before the stock existed (the report warns `NEGATIVE_STOCK_AS_OF`).
- **Restore of an upload over 200 MB and a true concurrent restore (`409`) are not exercised by tests** (the 503 guard during a restore is). Launcher repair of an incomplete `node_modules` is not automatic (run `npm ci`); stale-build detection looks at file times under `web/src`, `web/index.html` and `web/vite.config.ts` only.
- **Telecom cash book does not reconcile to Telecom profit** by owner decision (R14: no reload float or wallet tracking).
- **Not built (never promised by an approved rule):** editing a saved record in place (the model is void and re-enter), importing historical data, multi-user access, card or credit payments, a go-live checklist endpoint.

### Observations from the independent QA pass (Phase 14) — accepted, none changes a figure
- **Migration runner** detects a modified or newer-than-app migration but does not notice an applied migration whose file was deleted from disk.
- **`import_runs.business_date` and `audit_logs.business_date`** have no future-date trigger (metadata only; every business record table has one).
- **Ice Cream payment `category` is free text:** only the exact word "electricity" (trimmed, any case) is refused (E4); "electricity bill" or "electric" are accepted there. Expense categories are a closed list and robust.
- **NUL characters** are accepted in free-text fields.
- **A second void of an Ice Cream daily entry** answers 404 (it is addressed by date) instead of 409 ALREADY_VOID.
- **A stocktake draft** can be created on a closed day (only completing it is refused, DAY_CLOSED).
- **Restore** checks integrity and schema only: a backup whose stock cache disagrees with its movements restores and is flagged afterwards by `/inventory/reconciliation`. A tampered backup checksum is refused with 500 RESTORE_FAILED (data intact) rather than 422.
- **Very large balances:** per-request limits keep every amount far below 2^53 cents; only an absurd number of 10^12-cent entries could exceed it.

### Future enhancements (owner-approved to defer)
- **Stocktake expected quantity at count time** (BUSINESS_RULES §13A decision 4): record the expected quantity when each line is counted and adjust for movements since, so a stocktake can safely run while the shop is trading. Until then: complete the stocktake immediately after counting, when the shop is quiet.
- **POS service lines** (decision 7): not planned; services use Services → Service types.

### Hardening pass M1-M7 (owner-approved and DONE 2026-11-14)
- M1 closed days enforced by database triggers on every business-date table (migration 019); M2/M3/M4/L2 void-needs-reversal, return reversal caps, one refund and one restock set per return, `schema_migrations` and `INSERT OR REPLACE` guards (migration 020); M5/M6 accurate external-backup status and bounded failure log (migration 021); M7 restore validation before the live database is touched (`database-validation.ts`). Details: migrations README, API_CONTRACTS "Hardening contract".
- Still open from the audit: L1/L3 (letter-case clash on the drive, cloud-name rule false positives such as a folder called Boxes). Restore cannot detect a consistent change inside free-text columns.
- Real USB drive test still to be done by the owner (README checklist and `scripts/verify-external-backup.mjs`).
