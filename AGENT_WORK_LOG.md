# Agent Work Log

Every subagent run is recorded here by the orchestrator after review: agent, model, task, files, tests, assumptions, review outcome.

## Pre-Phase-1
| When | Agent | Model | Task | Outcome |
|---|---|---|---|---|
| 2026-11-10 | Financial Logic | claude-sonnet-5-5 (self-reported) | Independent review of all financial rules in the plan | APPROVE WITH CHANGES — 14 findings; 13 accepted, #10's alternative rejected (would double-count electricity). Resolutions R1–R14 in BUSINESS_RULES.md |

## Phase 1
| When | Agent | Model | Wave | Files | Agent's verification | Orchestrator review |
|---|---|---|---|---|---|---|
| 2026-11-10 | Orchestrator | claude-opus-5-5 | A | root/server/web package.json, tsconfigs, vitest config, 7 docs | npm install (212 pkgs); smoke: vitest loads `node:sqlite`, Node strips TS | Pinned mature majors (TS 5.9, Vite 7, Vitest 3.2, RR 7) instead of newest (TS 7/Vite 8/Vitest 5/RR 8) for stability |
| 2026-11-10 | DevOps/Docs | sonnet | B | `Start-Viman-Shop.bat`, `scripts/{check-node,needs-build,open-when-ready}.mjs`, README.md, .gitignore | scripts run with expected exit codes; .bat ASCII + CRLF verified | **Accepted with 1 fix:** browser opener used `cmd /c start '""' url` — Node re-escapes the literal `""` title, unsafe with cmd quoting → replaced with `rundll32 url.dll,FileProtocolHandler` |
| 2026-11-10 | Financial Logic | claude-sonnet-5-5 | B | `server/src/tests/finance/money.test.ts` (49 tests) | hand-derived vectors (half-away rounding, value-pool sequences, 9e12×3/7, MAX_SAFE bounds) | **Accepted.** Its 12-point BUSINESS_RULES review all accepted as clarifications C1–C12 (notably: electricity blocked in `icecream_other_expense`; electricity true-up path; over/short sign) |
| 2026-11-10 | DB Architect | sonnet | B | `db/db.ts`, `db/migrate.ts`, `db/migrations/001_foundation.sql`, `repositories/{settings,audit}.repo.ts` | ad-hoc script: migrate idempotent, checksum tamper, too-new, nested savepoints, close/reopen | **Accepted** — matches contract; savepoint rollback, async rejection, WAL checkpoint on close, LF-normalised checksums all verified by reading the code |
| 2026-11-10 | Frontend | sonnet | B | `web/**` (config, 15 components, layout, Dashboard status, ComingSoon, Settings: General/Rates/Printing/Backups/Audit) | `tsc -b && vite build` clean (340 kB JS) | **Accepted with 2 fixes:** (1) `units.ts` stripped *all* commas so a typo `1,2,3` became Rs 123 → commas now only valid as thousands groups (9 converter cases verified); (2) nav copy promised receipts / opening cash in Opening Stock — not in plan → corrected |
| 2026-11-10 | Backend | sonnet | C | `lib/{money,dates,errors}.ts`, `app.ts`, `index.ts`, `services/{settings,audit,backup}.service.ts`, `routes/{health,settings,audit-logs,backups}.ts` | finance 49/49; tsc clean; full smoke incl. restore + junk upload + EADDRINUSE | **Accepted with 1 fix:** Ajv type coercion was left on for bodies (`null` → 0 for money) → `coerceTypes:false` app-wide; audit-log query params now validated digit strings; verified null/"600" → 400. Contract updated |
| 2026-11-10 | QA | sonnet | D | `server/src/tests/{db,migrate,health,settings,audit,backups,restore,static,dates,startup}.test.ts`, `tests/helpers/{tmp,multipart}.ts` | 140 tests + finance 49 = 189 pass; no product bugs found | **Accepted after 3 follow-ups requested by orchestrator:** (1) restore-rollback path *is* testable (backup with tampered migration checksum passes validation, fails `migrate()` after swap) → 3 tests added; (2) startup test tightened after `index.ts` fix (busy-port 2nd instance must create no backup); (3) 8 static-asset regression tests after browser-found bug. Final 200/200 |

## Phase 1 — orchestrator integration fixes (found in review / browser verification)
| # | Area | Problem | Fix | Verified by |
|---|---|---|---|---|
| I-1 | `scripts/open-when-ready.mjs` | `cmd /c start '""' url` — Node re-escapes the literal `""` | `rundll32 url.dll,FileProtocolHandler` | launcher run |
| I-2 | `web/src/lib/units.ts` | all commas stripped (`1,2,3` → Rs 123) | commas only as thousands groups | 9 converter cases |
| I-3 | `web/src/layout/navItems.ts` | copy promised receipts / opening cash in Opening Stock (not in plan) | copy corrected | review |
| I-4 | `server/src/app.ts` | Ajv coercion on bodies (`null` money → 0) | `coerceTypes:false`; audit query params validated as digit strings | settings tests (null / "600" → 400) |
| I-5 | `server/src/index.ts` | 2nd launch on busy port took a startup backup before failing | listen first, then backup | startup.test.ts |
| I-6 | `server/src/app.ts` | **browser-found:** `@fastify/static` `wildcard:false` ignored assets built after start + SPA fallback served `index.html` for missing `.js` → blank page | wildcard on; no HTML fallback for `/assets/*` or paths with a file extension | 8 static tests + live rebuild in browser |
| I-7 | `web/src/components/Tabs.tsx` | `overflow-x:auto` forced `overflow-y:auto` → stray scrollbar on Settings tabs | `overflow-y-hidden` | screenshot |
| I-8 | `web/index.html` | no favicon → console 404 on every load | inline SVG icon | 0 console errors |

## Phase 1 — final review (2026-11-10, owner-requested)
| # | Finding | Severity | Fix | Owner | Verified |
|---|---|---|---|---|---|
| FR-1 | `synchronous=NORMAL` could lose the last committed entries on a power cut | High | `synchronous=FULL` | Orchestrator (db.ts) | db.test (=2) |
| FR-2 | `audit_logs` append-only documented but not enforced by the DB | Medium | migration `002_audit_append_only.sql` (triggers) | Orchestrator | migrate/audit/restore tests; live DB refuses DELETE |
| FR-3 | Restore copied over `viman.db` in place → power cut mid-copy = half-written live DB | High | atomic same-folder rename (+ rollback via tmp+rename) | Orchestrator (backup.service) | restore tests, no temp leftovers |
| FR-4 | Damaged live DB → raw stack trace, owner locked out (Restore UI unreachable) | High | read-only `quick_check` pre-flight before any write; recovery steps + newest backups; no backup of a damaged DB | Orchestrator (index.ts) | 3 spawned-process tests (byte-identical file, no backups, no listen) + healthy no-false-alarm test |
| FR-5 | Crash leftovers (`upload-*.tmp.db`, candidate, rollback tmp, `*.db.tmp`) never cleaned | Low | `cleanupStaleTempFiles` after listen | Orchestrator | backups + startup tests |
| FR-6 | Contract table missing 413 FILE_TOO_LARGE / 500 RESTORE_FAILED; 409 vs 503 behaviour undocumented | Low | API_CONTRACTS updated | Orchestrator | review |
| FR-7 | web `AuditLog.entityId` typed `string`, contract allows null | Low | `string \| null` | Orchestrator | typecheck |
| FR-8 | Electricity/expense doc contradictions for Phases 8–10 | Medium (future) | **proposed only** (BUSINESS_RULES §14 P-2) | — | pending owner |
| FR-9 | Ice cream fund model (owner clarification) | — | **proposed only** (§14 P-1) | — | pending owner |
QA (sonnet) updated/added tests for FR-1…FR-5 (212 → 213 after the read-only pre-flight change requested by QA's own observation that the first version flipped the header to WAL before the "nothing was changed" message).

## Owner decisions after Phase 1 review (2026-11-10)
| When | Agent | Model | Task | Outcome |
|---|---|---|---|---|
| 2026-11-10 | Orchestrator | claude-opus-5-5 | Apply **P-2 (approved)**: electricity rule E1–E5 in BUSINESS_RULES §7/§1/§2; `expenses` CHECKs (book shop/telecom, no electricity category) in DATABASE_SCHEMA; `ELECTRICITY_NOT_ALLOWED` / `USE_ICECREAM_PAYMENTS` in API_CONTRACTS | Done |
| 2026-11-10 | Orchestrator | claude-opus-5-5 | Draft **P-1** ice cream funds per owner correction (moves into Profit raise recognized profit; withdrawals never reduce it; exactly-once) | Release limit = unspent allocation (charged − settled) |
| 2026-11-10 | Financial Logic | claude-sonnet-5-5 | Adversarial break-test of P-1 (11 scenarios) | SOUND WITH CHANGES. Proved recognized − true profit = −unspent. Accepted: void guard (VOID_BREAKS_RELEASE), per-line + combined release limits, Cost↔Electricity line re-label (orchestrator bounded it by the source line's unspent allocation so capital cannot create headroom), memo rows. Not auto-applied: "profit after excess cost" as official figure (conflicts with E3) → owner decision D3; block-vs-split for stranded funds → owner decision D4 |
| 2026-11-10 | Orchestrator | claude-opus-5-5 | Owner approved P-1 with **D1, D2, D3-A, D4-A** → promoted to BUSINESS_RULES §10 (final); §1/§2/§7/§8/§9/C2/C9 aligned; DATABASE_SCHEMA and API_CONTRACTS conditional branches removed; D3 excess-cost fields added to every Ice Cream/Combined report shape; D4 preview + `SPLIT_CONFIRMATION_REQUIRED` flow | Done — Financial Logic re-review requested |
| 2026-11-10 | Financial Logic | claude-sonnet-5-5 | Re-review of FINAL rules (3 docs) | CONTRADICTIONS FOUND (none break the money model; D1–D4 + P-2 all PASS). Orchestrator accepted and applied 17 of 18: fund ledger created with cash book in Phase 8 (#1); posted-only unique index for void-and-replace (#2); one `icecream_sale` cash entry per fund share (#3); client_ref/status on `cash_counts`/`icecream_days` (#4); excess-cost wording (#5); flow-vs-balance period semantics with cumulative "profit after excess cost" (#6, owner to confirm); void guard made precise (#7); stale names/C2 removed (#8–#10); type/book + case-insensitive electricity CHECKs, no goods drawings in Ice Cream (#11); D3 fields on fund report + dashboard (#12); history endpoints, fund required in API (#13); D4 re-confirmation on changed split (#14); DAY_CLOSED for all Ice Cream writes (#15); contract doc said synchronous=NORMAL → FULL (#16); negative-profit CHECK (#18). #17 left to C8 (summary columns). |
| 2026-11-10 | Orchestrator | claude-opus-5-5 | Owner's four confirmations (period-flow rows, other costs reduce allocation, over/short default Profit, posting order vs business date) written into all three docs | Done |
| 2026-11-10 | Financial Logic | claude-sonnet-5-5 | LAST consistency review + numeric 2-month proof of the period rule (incl. backdated entry) | CONSISTENT WITH MINOR FIXES — Σ days = month, Σ months = total, no double deduction, backdated restatement correct, identity holds. Orchestrator applied 10 doc fixes: one meaning per term ("excess cost not yet charged" = period change; "outstanding excess cost" = balance; warning code `EXCESS_COST_OUTSTANDING`); planned Phase 8 `audit_logs` columns `business_date`/`backdated`; reversal rows keep the original business date; dropped `sales.sold_at` and `icecream_days.updated_at`; balances block in Ice Cream P&L; period charge lines = movements; negative excess display rule; `confirmedProfitEligibleCents`; business-date basis for `asOf/from/to`; Settled attribution in schema; restore example v2. Future-date blocking NOT applied (new rule) → recorded as open recommendation R-FD for the owner. |
| 2026-11-10 | Orchestrator | claude-opus-5-5 | Owner approved **R-FD** (block future-dated entries; backdating allowed; server-enforced; exact message; all financial transactions; posting timestamp uneditable) → BUSINESS_RULES §12, DATABASE_SCHEMA (service check + BEFORE INSERT/UPDATE triggers using `date('now','+330 minutes')`, since SQLite CHECK cannot use `date('now')`), API_CONTRACTS (`400 FUTURE_DATE_NOT_ALLOWED` on every financial write, `postedAt` rejected in bodies) | Done — final consistency review requested |
| 2026-11-10 | Financial Logic | claude-sonnet-5-5 | FINAL review incl. R-FD | CONSISTENT WITH MINOR FIXES — message/code identical across docs; trigger timing correct (can only be more lenient than the service at midnight); no conflict with reversals, void-and-replace, reopen, backdating, D4 near midnight. Orchestrator applied 11 doc fixes: opening-stock import date rule (#1); `daily_closings.posted_at` immutable first-close time (#2); `POSTED_AT_IMMUTABLE` triggers on non-ledger financial tables (#3); strict date-format CHECK (#4); ABORT→400 mapping (#5); reports never rejected (#6); validation order (#7); explicit return/replacement scope (#8, #9); write paths use the real clock (#10); DAY_CLOSED all books (#11). Not applied (new rule): "return not dated before its sale/purchase" → recorded as optional suggestion for the owner. |
| 2026-11-10 | Orchestrator | claude-opus-5-5 | Owner approved **R-RD** (return date ≥ original sale/purchase date; backdated returns allowed on/after original; backend + DB enforcement; clear message) → BUSINESS_RULES §3/§4/§12/§14, DATABASE_SCHEMA (service check + `sales_returns`/`purchase_returns` BEFORE INSERT/UPDATE triggers reading the original header — CHECK cannot read another table), API_CONTRACTS (`400 RETURN_BEFORE_ORIGINAL_DATE` naming the original date, `originalDate` in body; validation order schema → R-FD → R-RD → DAY_CLOSED → rules) | Done — final consistency review requested |
| 2026-11-10 | Financial Logic | claude-sonnet-5-5 | Final documentation review incl. R-RD | CONSISTENT WITH MINOR FIXES, no owner decisions. Orchestrator applied all 8: original sale/purchase business_date immutable in DB (`BUSINESS_DATE_IMMUTABLE`); NOT NULL return FKs + `RETURN_ITEM_MISMATCH` triggers; trigger-vs-CHECK ordering note; residual-sweep dates; `stock_losses.sales_return_id` link; validation order incl. original lookup (404) and DAY_CLOSED on the return's date; message "…or a later date (not after today)" identical in all docs; R-RD own heading in §14 |

## Phase 2 — Catalog (2026-11-10)
| Agent | Model | Files | Orchestrator review |
|---|---|---|---|
| DB Architect | sonnet | 003_catalog.sql, 3 repositories | Accepted — matches contract; all constraints/triggers verified by agent and by tests |
| Frontend | sonnet | web/src/pages/products/*, api/catalog.ts, 2 components | Accepted — integer-only money handling checked; browser-verified |
| Backend | sonnet | catalog.service.ts, 4 route files, app.ts registration | Accepted — one tx per write with audit row; avg cost via mulDivRound |
| QA | sonnet | 4 catalog test files + helper; startup.test fix | Accepted — no skipped tests; 299/299 |

## Phase 3 — Purchases, inventory (2026-11-11)
| Agent | Model | Files | Orchestrator review |
|---|---|---|---|
| DB Architect | sonnet | 004 migration, 3 repos, audit.repo | Accepted — trigger-driven stock cache; 83 agent checks |
| Frontend | sonnet | web/src/pages/purchases/*, api/purchases.ts, Modal | Accepted — integer-only math; browser-verified |
| Backend | sonnet | inventory.service, purchases.service, 2 route files, audit/errors/app edits | Accepted — engine read line by line; demo numbers re-derived by hand (all match to the cent) |
| QA | sonnet | 4 test files + helper (+2 fixed tests) | Accepted — QA connection dropped mid-run; resumed; 4 failures were test mistakes (hand-verified), no code bugs |
| Orchestrator | opus/sonnet | contract + schema detail, review | Cash ledger created early (owner decision); audit columns moved to Phase 3 (documented) |
