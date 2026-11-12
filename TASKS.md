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

- **Printing defaults in Settings do nothing.** Settings → Printing defaults edits `settings.printDefaults`, which no service reads. Print prices and standard costs live in `print_service_types` (Printing → Service types), seeded once by migration 010. Decision needed: remove the Settings tab, or make it seed or edit the types.
- **Service products cannot be sold in the POS.** A product with kind `service` is refused on a sale line (`PRODUCT_NOT_SELLABLE_YET`, message "Service products cannot be sold yet."). Printing and photocopying use their own tables; there is no other way to sell an "other service". Services can still be created in Products.
- **Negative-cash warning is missing on some voids.** Voiding a sale, a print sale, a reload sale or an EZCash sale removes cash from its book but returns no `NEGATIVE_CASH_BALANCE` warning (creates, returns, top-ups, supplies, expenses, drawings, transfers, counts and Ice Cream writes do).
- **Two allowed values are never written:** cash entry type `expense_refund` and stock movement type `sale_void` (an expense void reverses the `expense` entry; a sale void reverses with type `sale`).
- **A database trigger abort that no service maps becomes `500 INTERNAL_ERROR`.** Services map the aborts they expect (future date, closed day, invalid date, return dates, stock limits, ...); an unexpected one such as `PRODUCT_BOOK_MISMATCH` is not translated.
- **No automated tests for the web app.** It is covered by typecheck, the production build and manual browser passes.
- **Single user, no login.** The server listens on `127.0.0.1` by default; `VIMAN_HOST` can expose it, but there is no authentication.
- **Launcher port.** `Start-Viman-Shop.bat` opens `http://localhost:4300` in its "already running" branch even if `VIMAN_PORT` differs, and the Vite dev proxy is fixed to port 4300.
- **Stock valuation for a past date can show negative quantity** when a loss was backdated before the stock existed (the report warns `NEGATIVE_STOCK_AS_OF`).
- **Restore of an upload over 200 MB and a true concurrent restore (`409`) are not exercised by tests** (the 503 guard during a restore is). Launcher repair of an incomplete `node_modules` is not automatic (run `npm ci`); stale-build detection looks at file times under `web/src`, `web/index.html` and `web/vite.config.ts` only.
- **Telecom cash book does not reconcile to Telecom profit** by owner decision (R14: no reload float or wallet tracking).
- **Sidebar descriptions in `web/src/layout/navItems.ts` are only used by the unused "Coming soon" page**; some wording is out of date (for example Sales says "cash sales of goods and services").
- **Not built (never promised by an approved rule):** editing a saved record in place (the model is void and re-enter), importing historical data, multi-user access, card or credit payments, a go-live checklist endpoint.
