# Proposal: Telecom split into 4 providers x 2 kinds = 8 separately calculated cash books

**Status: DESIGN ONLY. Nothing is implemented. This changes the approved structure of the cash books (BUSINESS_RULES section 0 and 1: three logical cash books), so it needs your explicit approval first.**

## 1. What you asked for

Inside Telecom there are **4 providers**: Dialog, Mobitel, Airtel, Hutch. Each provider has **2 kinds**: **Cards** (scratch cards) and **Reloads**. Each of these **8 combinations has its own cash book**, calculated separately (its own balance, its own profit).

## 2. What exists today (so you can see what changes)

- One Telecom cash book. All reload collections, EZCash collections, card sales and refunds, top-ups, card purchases and Telecom expenses go into it.
- **Reloads** already record the provider on every entry (Dialog, Mobitel, Hutch, Airtel are seeded) and each entry stores its commission rate. But the cash goes into the one Telecom book.
- **Cards** are ordinary stock products in the book Telecom, sorted only by category (you have created "Dialog Crds" and "Airtel Crds"). Nothing links a category to a provider.
- **EZCash** (wallet bill payments) always belongs to Dialog. It is neither a card nor a reload today.
- Closing a day, counting the drawer, opening balances, transfers and the reports work per book. The database has the three book names built into about 20 tables, so adding books is a real structural change, not a setting.

## 3. Two ways to build it

**Option A (recommended): eight "segments" inside the Telecom book.**
The Telecom book stays one book in the database. Every Telecom cash entry, card sale, reload, top-up, expense and stock purchase additionally carries a **segment** (Dialog Cards, Dialog Reloads, Mobitel Cards, ... Hutch Reloads). On screen each segment behaves like its own cash book: its own balance, ledger, opening balance, drawer count and **Close day**, and its own profit and loss. The Telecom total is simply the sum of the 8. The database refuses a Telecom entry without a segment.
- Pro: far less risk to the approved accounting (the three-book structure, reports, dashboard, transfers stay as they are; existing history stays valid). Migration only adds a column and rules.
- Con: "book" in the code means Shop / Telecom / Ice Cream; segments are a second level.

**Option B: eight real books** (the database knows 10 books: shop, icecream and the 8 telecom books).
- Pro: the simplest picture.
- Con: every table, trigger, closed-day rule, transfer rule, report and the dashboard that mentions a book must change (migrations rebuild about 20 tables). Highest risk, and no real accounting benefit over Option A. Not recommended.

## 4. How each Telecom record would get its segment (rules to approve)

| Record | Segment |
|---|---|
| Reload collection | provider chosen on the entry + **Reloads** (already recorded) |
| Provider top-up (cash you pay to refill a provider) | that provider + **Reloads** |
| Card purchase / opening stock of cards | the product's **provider** + **Cards** |
| Card sale (POS) and card refund | the product's provider + **Cards**; a cart with cards of several providers is saved as one sale per segment (like a mixed Shop + Telecom cart is today) |
| EZCash bill collection and wallet top-up | **Decision 1** below |
| Telecom expenses | **Decision 2** below |
| Capital, owner cash drawings, over/short | the segment chosen when entered (required) |
| Transfers | between any two of the 10 books/segments; a transfer needs both sides named |

**How a card product gets its provider.** Each Telecom category is linked to one provider (for example "Dialog Crds" -> Dialog, "Airtel Crds" -> Airtel). You choose the provider when you create or edit a Telecom category; products inherit it. Categories without a provider cannot be used for card products. (This matches what you are already doing when you create "Dialog Crds".)

## 5. What is calculated separately per segment

- **Cash book:** opening balance, entries, running balance, drawer count, over/short, closing and reopening of a day **per segment** (one day can be closed for Dialog Reloads and still open for Mobitel Cards).
- **Profit and loss per segment:** Reloads segment = commission (+ rounding extra) minus its expenses; Cards segment = card sales minus card COGS minus stock adjustments minus its expenses. The Telecom report shows the 8 columns and the **Telecom total = sum of the 8**; the Combined P&L and the dashboard totals are unchanged in meaning.
- **Stock:** card stock stays per product as today and is valued per segment through its product.
- **Warnings:** the "cash book below zero" warning is given per segment.

## 6. Existing data

All current Telecom history has no segment. The migration keeps every row unchanged and shows it under one extra read-only segment called **"Telecom before segments"**; its balance continues to be correct. You decide the starting position in one of two ways: (a) leave the old balance there and use it down over time, or (b) **transfer** the old balance to the eight segments with ordinary transfers (a transfer entry per segment, appended, nothing edited). Nothing historical is rewritten (append-only rules unchanged).

## 7. What does not change

The Shop and Ice Cream books and their rules; weighted-average costing; C13 extra cost; returns and voids (a segment's entries are reversed in the same segment); closed-day, backdating, future-date rules (applied per segment); append-only ledgers; the "correct this entry" feature (the replacement keeps the segment).

## 8. Size and order of work (if approved)

Large: a migration adding segment columns and rules to about 12 Telecom-related tables with triggers (the closed-day and void protections are re-created per segment), category-to-provider link, services for reloads/cards/top-ups/expenses/transfers/closing/reports/dashboard, and the Cash Books, Telecom, POS and Reports screens. Estimated as several work packages, built after Phase 1 and Phase 2 of the corrections and before discounts (it changes the structure that discounts and reports sit on).

## 9. Decisions I need from you

1. **EZCash:** which segment? Options: (a) Dialog Reloads (recommended: it is a Dialog service paid through the Dialog wallet) or (b) its own ninth cash book "Dialog EZCash".
2. **Telecom expenses** (rent, transport... of the Telecom side): put them in one segment you choose per expense (recommended), or keep one shared "Telecom general" cash book as a ninth book that carries them.
3. **Option A or Option B** (recommended A).
4. **Old Telecom balance:** leave it under "Telecom before segments" (a) or transfer it into the 8 segments (b).
5. **Commission rate per provider** stays as today (each provider has its own rate in Settings). Confirm no change.
6. **Mixed card cart** (cards of several providers in one sale): saved as one sale per segment with the cash split accordingly (recommended). Confirm.
7. Confirm that Reloads and Cards each get their own profit line, and that the Combined P&L keeps showing a single Telecom total.
