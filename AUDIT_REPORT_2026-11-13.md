# Final independent audit — 2026-11-13

Scope: everything merged up to and including pull request #13 (migrations 001–018). Audit only: no feature was added, no approved rule changed, no production code, migration or existing test was modified, and nothing historical was altered. Six independent agents (fresh context, they did not write the code) and the orchestrator took part. Defects were **reported, not fixed**. The deliberate failing reproductions are on the branch `audit/defect-reproductions`; the passing audit tests are in `feature/final-audit`.

## Verdict
**No Critical and no High finding.** No historical financial record changed. All figures verified by hand arithmetic and by independent models matched. There are **7 Medium** and a number of **Low** findings, mostly *protection gaps that can only be reached by editing the database directly with SQL* (not through the screens), plus two behaviour problems in the new external-backup status. **Recommended for actual shop operations, with the conditions at the end of this report.** No real USB drive was available, so **USB testing was not performed**.

## 1. Reduced test coverage (the two model tests)
Cause (measured by running both tests on the code before and after PR #13): the tests pick every write date at random from a 5–6 day window while closings are scattered over the same window. After a few closings most random dates fall on or before the latest closed day and are (correctly) refused by the new rule, so fewer writes are *accepted*. Every refusal is still checked against an independent model.

| Test | Check | Previous threshold | New threshold | Measured before → after |
|---|---|---|---|---|
| phase8-model, seed 20261111 (420 steps) | accepted | > 150 | > 50 | 182 → 67 |
| | nonZeroCounts | > 10 | > 5 | 24 → 8 |
| | voids | > 10 | > 5 | 19 → 9 |
| | openingExists (unchanged, > 3) | > 3 | > 3 | 19 → 4 (margin 1) |
| | closedRejections (unchanged) | > 10 | > 10 | 150 → 278 |
| phase8-model, seed 7 (300 steps) | accepted (unchanged) | > 100 | > 100 | 157 → 117 |
| phase9-model, 3 seeds (300 steps) | created | > 70 | > 40 | 144/119/98 → 124/88/51 |
| | transfers | > 30 | > 10 | 86/62/32 → 74/44/13 |
| | icecreamLegs (unchanged) | > 30 | > 30 | 84/59/50 → 75/45/32 (margin 2) |
| | voids (unchanged) | > 15 | > 15 | 39/46/39 → 37/36/19 |

Still covered by the reduced tests: every transaction kind and every void kind is still exercised at least once, and every refusal code (DAY_CLOSED, BACKDATE_BEFORE_CLOSED_DAY, ALREADY_VOID, OPENING_BALANCE_EXISTS) is hit. **Thinned** (tiny counts, no per-kind guarantee in the originals): print sale accepted once, reload 3, purchase 4, several void kinds 1–2 each (seed 20261111); duplicate transfer replayed once, 13 transfers (seed 424242). **Not covered at all: nothing.**

Remedy (new tests only, **no threshold lowered anywhere**): `phase19-model-ledger` and `phase19-model-transfers` are date-policy-aware copies of both models (about 78 % of writes use a permitted date, the rest are deliberately blocked) that assert the **original pre-rule thresholds** with margins (for example accepted 258 vs > 150, transfers 50 vs > 30), plus per-kind coverage assertions (every operation kind accepted ≥ 5 times, every void kind ≥ 2, each refusal code seen). Recommendation: keep both; no further tests needed.

## 2. Sales-return void accounting audit
Hand-calculated scenarios (figures worked out first, in test comments) and 6 randomized seeds (2,469 steps) against an independent model, with reconciliation and duplicate checks after every step. **All matched; no defect in the service path.** Covered: multi-product returns (profit 6,402 → 3,069 → −1,932 → 3,069 → 6,402 across posts and voids; cash 5,000,002 → 4,990,501 → 4,982,499 and back); four partial returns on two lines voided in all 24 orders (exactly 2 orders succeed, all others refused with `RETURN_NOT_NEWEST` naming the newest, nothing written); awkward rounding (9 returns of cost 100 over 9 units = 11 × 8 then 12; half-cent cases); C13 extra cost on every path; weighted-average pool after return and void including the **gain** path (pool 4/333, restored 400, removed 333, gain 67) and the **sweep** path (pool 3/350, restored 300, sweep 50 then 300) with the identity *P&L = cash + stock* exact; damaged returns (loss row, no movement, restored on void); resold units (refused, `onHand`/`needed` correct, nothing written, also multi-product with one short); cash reversal (amount, book, original date, link); closed-day and ordering errors; negative-cash warnings; stock reconciliation after every step.
Duplicates: 8 concurrent voids → one success and seven `ALREADY_VOID`; 8 concurrent replays and creates → nothing duplicated; three void → re-return → void cycles leave exactly 6 cash rows and 6 movements; per return exactly one refund entry, at most one reversal, one restock and one reversal movement per line, at most one sweep. Raw-SQL attempts to insert a second reversal, edit a voided return, un-void, delete, or set a wrong `returned_qty` are all refused by the database. Two **database-level gaps** found (Medium, see M3, M4).

## 3. Closed-day ordering audit
62 write routes were enumerated (42 financial); the inventory test pins every route so a new one fails until classified. 255 new tests passed (matrix of 56 operations × per book, DB characterization, edge cases, concurrency, four 400-operation randomized runs with an independent model). **Result: no write lands on or before a closed day through the server in any tested case; the server check and the database trigger never disagreed.**

| Write | Server check | Database protection |
|---|---|---|
| Sales, returns, return voids, purchases, purchase returns, expenses, capital, opening balances, cash drawings, reloads, EZCash, top-ups, print sales, supplies, transfers (both books), counts with an adjustment (+ voids) | yes | the **cash row only** |
| Stock losses, goods drawings, stocktake completion, opening stock (manual, Excel) (+ voids) | yes (by the products' books) | **none** (no cash row) |
| Ice Cream days, payments, fund moves | yes | insert triggers (and void triggers for days and fund moves; **not** for payment voids) |
| Zero-difference cash counts | exact day only | none |
| Catalog, settings, backups, previews | not blocked (verified) | n/a |

## 4. External backup audit
**USB drive: NOT PERFORMED.** `Win32_LogicalDisk` showed only the fixed disk C: and `Get-Disk` only the internal NVMe. Nothing below claims a real USB test passed. Instead: real NTFS mechanisms on temporary folders (folder renamed away, non-existent drive letter, a deny-write ACL for "read-only", junction, SUBST) and test hooks for faults, as marked. New tool for the owner: `node scripts\verify-external-backup.mjs <folder>` (read-only; compares every copy with its local original by SHA-256, opens each as a database, flags leftover temporary files).

| Item | How tested | Result |
|---|---|---|
| Actual USB drive | not performed | — |
| Missing drive | real (rename away, drive letter Z:) | PASS: status drive_missing, shop/manual backup/restore unaffected, no log spam |
| Reconnected drive | real | PASS: copied once, SHA-256 equal, no duplicates |
| Read-only drive | real (NTFS deny ACE) | PASS: Save refused with a clear message; copy fails safely |
| Full drive | **simulated** (ENOSPC hook) | PASS functionally |
| Checksum mismatch | **simulated** (flipped, truncated, zero, appended) | PASS: never gets a final name, status failed, later run succeeds |
| Duplicate filenames | real NTFS | PASS: identical skipped; different → `-2`, `-3`; original untouched; same-named directory not replaced |
| Retention (newest 30) | real (48 files + 12 look-alikes + sub-folders) | PASS: exactly 30 newest remain, nothing else touched |
| Automatic copy after start-up | real (two separate OS processes) | PASS (the 10-minute timer firing by itself was not observed; the function was tested directly) |
| Manual backup copy / Copy backup now | real | PASS (3 parallel clicks: each backup exactly once) |
| Restore from an external copy | real upload | PASS: 30 endpoints and a whole-table snapshot equal the backup moment; corrupt/truncated/garbage files refused with live data intact |
| Restore after the folder setting changed | real | PASS, no crash; documented: the setting and the log travel with the restored file |
Also: UNC and cloud-named paths refused, 280-character and Unicode paths work, 7-day boundary exact (6 d 23 h 59 m ok; 7 d stale), leftover `.tmp` files removed after 1 hour, only files this system created are ever pruned. Not done: mapped network drive, a real cloud client, symbolic links (needs privilege).

## 5. Browser verification (through `Start-Viman-Shop.bat`, orchestrator)
Services screen and menu; `/printing` redirects to `/services` — PASS. Void-return button present on the posted returns of a sale; voided returns shown as "Void" with reason — PASS. **Newest-first**: the older return's button is disabled with "Return #2 was made after this one on the same item(s); void it first." — PASS. **Resold stock**: "This return cannot be voided: 3 unit(s) came back into stock but only 1 are on hand now." — PASS. **Closed day** (return dated on the closed day): "That day is closed for the Shop cash book. Reopen it first (it will be recorded in the audit log)." — PASS. **Backdated before a closed day**: "A later day (2026-11-12) is already closed for the Shop cash book. Entries dated before it would change a closed day. Reopen that day first, or use a date after it." — PASS. After reopening the day the void succeeds ("Return voided.") — PASS. Settings → Backups: folder saved, "Copy backup now" → "1 copied", copies listed — PASS. Drive folder renamed away: Settings shows "Drive not found" with the plug-in instruction and the Dashboard shows the banner ending "Shop work is not affected."; plugged back in: status Working, banner gone — PASS (a **folder renamed on this PC**, not a USB drive). Console: no errors.

## 6. Final integrity checks
- **History preserved (PR #13 upgrade of a real pre-PR database built by the old code):** 40 tables, **571 rows compared column by column: 0 differences**; `schema_migrations` gained exactly 016, 017, 018; append-only tables identical with no new rows; `integrity_check` ok, `foreign_key_check` empty; 311 → 325 schema objects, **nothing removed**, 9 triggers recreated under the same name (closed-day guards, return immutability) and 9 added; **72 report endpoints (~47,000 fields) return identical figures** on the upgraded database apart from the documented new fields (`salesReturnVoidGainCents`, return `status`, external-backup block).
- **Independent reconciliation (own SQL, rich world incl. returns, void-returns, closed days, Ice Cream with D4 and excess cost):** integrity ok; stock Σ movements = cache for every product, none negative, valuation = Σ values; each cash book = Σ its entries = `/cashbooks` = `/dashboard`; every reversal row has an existing original with the opposite sign and the same date/book/fund and each original is reversed at most once; **Cost + Electricity + Profit = Ice Cream cash book = Σ fund ledger** = `/icecream/funds` = dashboard; for every voided record in all 19 voidable tables original + reversal nets to zero; returned quantities = Σ posted returns; no future dates; all 43 raw UPDATE and 25 raw DELETE probes on ledger and document tables refused. A second, orchestrator-written script on the live audit database: 17 of 17 checks passed.
- **Complete suite, typechecks, build:** see section 8.

## 7. Findings
**Critical: none. High: none.**

| ID | Severity | Finding | Reachable via the app? | Evidence |
|---|---|---|---|---|
| M1 | Medium | Database enforces closed days only for `cash_entries` and 3 Ice Cream record tables; 21 tables (stock movements, losses, stocktakes, drawings, opening stock, sales, purchases, returns, expenses, capital, counts, reload/EZCash/top-up/print/supplies, transfers, fund entries, import runs) accept a raw row dated before/on a closed day, so profit or stock of a closed period could change without a cash trace | No (service layer protects all) | `phase19-closedday-db` |
| M2 | Medium | Raw `UPDATE … SET status='void'` is accepted without reversal rows on returns (new in 017) and on 16 other document tables (also no void trigger on Ice Cream payments) | No (the app always writes the reversal) | history defect-1/2, closed-day D-2 |
| M3 | Medium | Return reversal movements: a value-only `sale_return` movement (qty 0) and a second residual sweep are accepted by raw SQL | No | `phase19-returnvoid-defect-1` |
| M4 | Medium→Low | A second refund cash entry and a second restock movement for one return are accepted by raw SQL (older, from migration 006; the service guards with `clientRef`) | No | returnvoid defect-2 |
| M5 | Medium | External backup: after 7+ days with all backups already on the drive, the stale warning says "press Copy backup now" but that never clears it (only a new backup does) | **Yes** (false warning) | backup defect-2 |
| M6 | Medium | External backup: while a drive stays read-only/full every 10-minute pass appends a failure row per pending backup (up to ~4,300 rows/day with 30 pending); log is append-only | **Yes** | backup defect-1 |
| M7 | Medium (design limit) | Restore checks structure only: flipped bytes at 33 of 40 tested positions were accepted | Yes (only for a damaged copy) | use `verify-external-backup.mjs` |
| L1 | Low | A backup already on the drive in another letter case fails every run (nothing overwritten) | Yes (rare) | backup defect-3 |
| L2 | Low | `schema_migrations` unguarded; a cash entry claiming to reverse an unrelated entry is accepted (only return reversals validated); `INSERT OR REPLACE` bypasses append-only triggers on `audit_logs`/`external_backup_log` | No | history defect-2, backup O7 |
| L3 | Low | Cloud-folder rule is by name: refuses "Boxes", "Megabytes"; accepts "One Drive", Nextcloud, SharePoint, Syncthing; junction folders fail with a raw `EEXIST` message; a folder on the same disk is accepted without warning; after switching folders the status uses the last success of any folder; setting a folder triggers no immediate copy | Yes | backup O3–O6 |
| L4 | Low | A stocktake draft can be created on a closed day (completion is refused); an Excel import with error rows writes import-run rows before the closed-day verdict; return/Ice Cream/stocktake voids check ALREADY_VOID before DAY_CLOSED (documented differences) | Yes | closed-day S-2..S-4 |
| L5 | Low/Info | By design: restore replaces the whole database (older backup reopens days closed after it); a void gain/sweep lands in the return's period; "newest return" is judged per sale line | — | — |

## 8. Final run on the proposed tree
Server typecheck clean; web typecheck clean; production build OK. **Complete server test suite on `feature/final-audit`: 124 files, 2,371 tests passed, 0 failed, 0 skipped** (1,981 before the audit plus about 390 new audit tests; 3 min 39 s). The branch contains all passing audit tests and no failing reproduction. The seven failing reproductions (11 tests) are on `audit/defect-reproductions`.

## 9. Remaining limitations
Real USB drive not tested; opening the app from a real phone and the Windows Firewall step not tested; mapped network drives and real cloud clients not tested; the 10-minute copy timer was not observed firing by itself in a long-running process; the web app has no automated UI tests (covered by typecheck, build and browser passes); single user and no login by design.

## 10. Recommendation
**Yes, for actual shop operations**, under these conditions: (1) before relying on the USB copy, run the real-drive checklist in `README.md` once (and `scripts\verify-external-backup.mjs`); (2) nobody edits `data\viman.db` with any other tool — M1–M4 and L2 all need direct SQL; (3) follow the operating rules (close days in order, complete stocktakes when the shop is quiet, swap USB drives weekly with one off-site); (4) review M5 and M6 soon (small, both affect the backup status and log, not your data); (5) keep the first weeks' paper or Excel notes for a cross-check. A hardening pass for M1–M4 (database triggers) and M5–M6 would take roughly one more working session and needs your approval first, because it changes migrations and code.
