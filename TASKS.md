# Tasks

Status: ☐ todo · ◐ in progress · ☑ done · ✖ blocked. Owner = agent role (all subagents run on Claude Sonnet 5.5; orchestrator Opus 5.5).

## Phase 1 — Foundation (complete — awaiting owner approval for Phase 2)
| # | Task | Owner | Wave | Status |
|---|---|---|---|---|
| 1.1 | Root/server/web package.json, tsconfigs, vitest config, dependency install | Orchestrator | A | ☑ |
| 1.2 | ARCHITECTURE, BUSINESS_RULES, API_CONTRACTS, DATABASE_SCHEMA, TASKS, AGENT_WORK_LOG, IMPLEMENTATION_STATUS | Orchestrator | A | ☑ |
| 1.3 | `db/db.ts` (AppDatabase, PRAGMAs, tx), `db/migrate.ts`, `001_foundation.sql`, settings & audit repositories | DB Architect | B | ☑ |
| 1.4 | Web shell: Vite/Tailwind/Router/Query, sidebar (13 sections), placeholders, Settings (general/rates/printing), Backups, Audit log, shared components | Frontend | B | ☑ |
| 1.5 | `Start-Viman-Shop.bat`, `scripts/*`, README, .gitignore | DevOps/Docs | B | ☑ |
| 1.6 | Independent money/rounding test vectors (`tests/finance/money.test.ts`) | Financial Logic | B | ☑ |
| 1.7 | `lib/` (money, dates, errors), `app.ts`, `index.ts`, settings/audit/backup services, health/settings/audit/backup routes | Backend | C | ☑ |
| 1.8 | Tests: migrations, db, settings API, audit, backups (create/rotate/restore/corrupt/too-new/persistence), health, SPA/static | QA | D | ☑ |
| 1.9 | Review & integrate, `npm test`, `npm run build`, launcher cold start, browser verification, status report | Orchestrator | — | ☑ |

## Phase 2 — Catalog (complete — awaiting owner approval for Phase 3)
| Task | Owner | Status |
|---|---|---|
| Contract detail (endpoints, repos) | Orchestrator | ☑ |
| Migration 003 + repositories | DB Architect | ☑ |
| Services + routes | Backend | ☑ |
| Products/Categories/Suppliers screens | Frontend | ☑ |
| Tests (86 new; startup test fixed) | QA | ☑ |

## Phase 3 — Purchases, stock movements, inventory (complete — awaiting owner approval for Phase 4)
| Task | Owner | Status |
|---|---|---|
| Contract + design (engine, cash ledger early) | Orchestrator | ☑ |
| Migration 004 + repositories | DB Architect | ☑ |
| Inventory engine, purchases service/routes | Backend | ☑ |
| Purchases screens, stock history | Frontend | ☑ |
| 172 new tests incl. weighted-average demo | QA | ☑ |

## Phase 4 — Stocktake, losses, personal use, valuation (complete — awaiting owner approval for Phase 5)
| Task | Owner | Status |
|---|---|---|
| Contract + schema detail | Orchestrator | ☑ |
| Migration 005 + repositories | DB Architect | ☑ |
| Stocktake / losses / drawings / valuation services + routes | Backend | ☑ |
| Stock section screens | Frontend | ☑ |
| 136 new tests incl. model check | QA | ☑ |

## Phase 5 — POS, sales, returns, voids (complete — awaiting owner approval for Phase 6)
| Task | Owner | Status |
|---|---|---|
| Contract + schema detail | Orchestrator | ☑ |
| Migration 006 + sales repository | DB Architect | ☑ |
| Sales / returns / void services + routes | Backend | ☑ |
| POS and History screens | Frontend | ☑ |
| 144 new tests incl. model check | QA | ☑ |
| Migration 007 delete guards (QA finding) | Orchestrator | ☑ |

## Later phases (not started — require owner approval)
2 Catalog · 3 Purchases & movements · 4 Costing/stocktake/valuation · 5 POS/returns/voids · 6 Telecom · 7 Printing · 8 Expenses (electricity blocked, §7) + 3 cash books (Ice Cream entries carry a fund) · 9 Transfers/drawings/capital/losses · 10 Ice cream three-fund system (BUSINESS_RULES §10) · 11 Reports · 12 Dashboard + exports · 13 Opening-stock Excel · 14 Full QA + docs.

## Wave 1 — Phases 6, 7, 13 (built and integrated 2026-11-11)
- [x] Phase 6 Telecom reloads, EZCash, top-ups (migration 009)
- [x] Phase 7 Printing service types, print sales, supplies (migration 010)
- [x] Phase 13 Opening stock + Excel template/preview/import (migration 011)
- [x] Integrate, full tests (1,127 pass)
- [ ] PR/merge; launcher browser verification in Phase 14
