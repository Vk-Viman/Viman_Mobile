-- 009_telecom.sql - Phase 6: telecom reloads, EZCash and top-ups (BUSINESS_RULES section 5).
--
-- Tables
--   reload_providers  Dialog, Mobitel, Hutch, Airtel (seeded). Master data: the commission rate and the active flag
--                     are editable; a rate change never alters past sales because every sale snapshots its rate.
--   reload_sales      one row per reload entry: the day's collection for a provider, the commission rate that applied
--                     and the resulting commission (+ the owner's rounding "extra").
--   ezcash_sales      EZCash bill collections (always under the provider named 'Dialog').
--   telecom_topups    cash the owner pays out to refill a provider (provider_topup) or the EZCash wallet (wallet_topup).
--
-- Accounting (all enforced by the service, the CHECKs/triggers below are the backstop):
--   * Telecom revenue is the COMMISSION only. The full collection goes to the Telecom cash book (reload_collection /
--     ezcash_collection); top-ups are cash-outs (provider_topup / wallet_topup). Commission is NOT a cash entry.
--   * No float or balance tracking (R14): nothing here records what the provider owes or holds.
--   * R-FD: no future business dates (BEFORE INSERT trigger, Colombo = UTC+5:30). Backdating stays allowed (audited).
--   * R1: rows are never edited or deleted; a void flips status posted -> void once and the service writes a
--     reversal cash entry. Business rows are immutable apart from that single transition.
--   * Duplicate-submission guard: client_ref is UNIQUE on every business table.
--
-- Runner wraps this file in a transaction. Money = integer cents, rates = basis points (600 bp = 6.00 %).

-- ---------------------------------------------------------------------------------------------
-- reload_providers
-- ---------------------------------------------------------------------------------------------
CREATE TABLE reload_providers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  -- NULL = "use the shop default" (settings.rates.reloadCommissionBp); otherwise the provider's own rate (C11).
  commission_bp INTEGER CHECK (commission_bp IS NULL OR commission_bp BETWEEN 0 AND 10000),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order    INTEGER NOT NULL DEFAULT 0
);

INSERT INTO reload_providers (name, sort_order) VALUES ('Dialog', 1), ('Mobitel', 2), ('Hutch', 3), ('Airtel', 4);

-- The EZCash trigger below identifies Dialog by name, so a provider can never be renamed or removed.
CREATE TRIGGER trg_reload_providers_name_immutable
BEFORE UPDATE OF name ON reload_providers
WHEN NEW.name IS NOT OLD.name
BEGIN
  SELECT RAISE(ABORT, 'PROVIDER_NAME_IMMUTABLE');
END;

CREATE TRIGGER trg_reload_providers_no_delete
BEFORE DELETE ON reload_providers
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------------------------
-- reload_sales
-- ---------------------------------------------------------------------------------------------
CREATE TABLE reload_sales (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date    TEXT    NOT NULL,
  posted_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  provider_id      INTEGER NOT NULL REFERENCES reload_providers(id),
  -- Upper bounds keep sales * rate inside 64-bit integers for the commission trigger below.
  sales_cents      INTEGER NOT NULL CHECK (sales_cents > 0 AND sales_cents <= 1000000000000),
  commission_bp    INTEGER NOT NULL CHECK (commission_bp BETWEEN 0 AND 10000),
  extra_cents      INTEGER NOT NULL DEFAULT 0 CHECK (extra_cents >= 0 AND extra_cents <= 1000000000000),
  commission_cents INTEGER NOT NULL CHECK (commission_cents >= 0),
  status           TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at        TEXT,
  void_reason      TEXT,
  notes            TEXT    NOT NULL DEFAULT '',
  client_ref       TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX idx_reload_sales_business_date ON reload_sales(business_date);
CREATE INDEX idx_reload_sales_provider_date ON reload_sales(provider_id, business_date);

CREATE TRIGGER trg_reload_sales_future_date
BEFORE INSERT ON reload_sales
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

-- Commission backstop (section 5): commission = round(sales * bp / 10000) + extra. All values are non-negative
-- integers, so integer "+ 5000, then divide" equals half-away-from-zero rounding (mulDivRound in the service).
CREATE TRIGGER trg_reload_sales_commission
BEFORE INSERT ON reload_sales
WHEN NEW.commission_cents <> ((NEW.sales_cents * NEW.commission_bp + 5000) / 10000) + NEW.extra_cents
BEGIN
  SELECT RAISE(ABORT, 'COMMISSION_MISMATCH');
END;

CREATE TRIGGER trg_reload_sales_business_date_immutable
BEFORE UPDATE OF business_date ON reload_sales
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_reload_sales_posted_at_immutable
BEFORE UPDATE OF posted_at ON reload_sales
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

-- Only posted -> void (status, voided_at, void_reason) may change; nothing else, and never back.
CREATE TRIGGER trg_reload_sales_immutable
BEFORE UPDATE OF id, provider_id, sales_cents, commission_bp, extra_cents, commission_cents, notes, client_ref, status, voided_at, void_reason ON reload_sales
WHEN NEW.id IS NOT OLD.id
  OR NEW.provider_id IS NOT OLD.provider_id
  OR NEW.sales_cents IS NOT OLD.sales_cents
  OR NEW.commission_bp IS NOT OLD.commission_bp
  OR NEW.extra_cents IS NOT OLD.extra_cents
  OR NEW.commission_cents IS NOT OLD.commission_cents
  OR NEW.notes IS NOT OLD.notes
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'RELOAD_SALE_IMMUTABLE');
END;

CREATE TRIGGER trg_reload_sales_no_delete
BEFORE DELETE ON reload_sales
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------------------------
-- ezcash_sales (bill collections; the provider is always the one named 'Dialog')
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ezcash_sales (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date    TEXT    NOT NULL,
  posted_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  provider_id      INTEGER NOT NULL REFERENCES reload_providers(id),
  bill_total_cents INTEGER NOT NULL CHECK (bill_total_cents > 0 AND bill_total_cents <= 1000000000000),
  commission_bp    INTEGER NOT NULL CHECK (commission_bp BETWEEN 0 AND 10000),
  commission_cents INTEGER NOT NULL CHECK (commission_cents >= 0),
  status           TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at        TEXT,
  void_reason      TEXT,
  notes            TEXT    NOT NULL DEFAULT '',
  client_ref       TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX idx_ezcash_sales_business_date ON ezcash_sales(business_date);
CREATE INDEX idx_ezcash_sales_provider_date ON ezcash_sales(provider_id, business_date);

CREATE TRIGGER trg_ezcash_sales_future_date
BEFORE INSERT ON ezcash_sales
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

-- EZCash is a Dialog service: any other provider (or an unknown id) is refused.
CREATE TRIGGER trg_ezcash_sales_provider_dialog
BEFORE INSERT ON ezcash_sales
WHEN (SELECT name FROM reload_providers WHERE id = NEW.provider_id) IS NOT 'Dialog'
BEGIN
  SELECT RAISE(ABORT, 'EZCASH_PROVIDER_NOT_DIALOG');
END;

CREATE TRIGGER trg_ezcash_sales_commission
BEFORE INSERT ON ezcash_sales
WHEN NEW.commission_cents <> ((NEW.bill_total_cents * NEW.commission_bp + 5000) / 10000)
BEGIN
  SELECT RAISE(ABORT, 'COMMISSION_MISMATCH');
END;

CREATE TRIGGER trg_ezcash_sales_business_date_immutable
BEFORE UPDATE OF business_date ON ezcash_sales
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_ezcash_sales_posted_at_immutable
BEFORE UPDATE OF posted_at ON ezcash_sales
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

CREATE TRIGGER trg_ezcash_sales_immutable
BEFORE UPDATE OF id, provider_id, bill_total_cents, commission_bp, commission_cents, notes, client_ref, status, voided_at, void_reason ON ezcash_sales
WHEN NEW.id IS NOT OLD.id
  OR NEW.provider_id IS NOT OLD.provider_id
  OR NEW.bill_total_cents IS NOT OLD.bill_total_cents
  OR NEW.commission_bp IS NOT OLD.commission_bp
  OR NEW.commission_cents IS NOT OLD.commission_cents
  OR NEW.notes IS NOT OLD.notes
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'EZCASH_SALE_IMMUTABLE');
END;

CREATE TRIGGER trg_ezcash_sales_no_delete
BEFORE DELETE ON ezcash_sales
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------------------------
-- telecom_topups (cash-outs: provider_topup names a provider, wallet_topup is the EZCash wallet = no provider)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE telecom_topups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT    NOT NULL,
  posted_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind          TEXT    NOT NULL CHECK (kind IN ('provider_topup','wallet_topup')),
  provider_id   INTEGER REFERENCES reload_providers(id),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 1000000000000),
  status        TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  voided_at     TEXT,
  void_reason   TEXT,
  notes         TEXT    NOT NULL DEFAULT '',
  client_ref    TEXT    NOT NULL UNIQUE,
  CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date),
  CHECK ((kind = 'provider_topup' AND provider_id IS NOT NULL) OR (kind = 'wallet_topup' AND provider_id IS NULL)),
  CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX idx_telecom_topups_business_date ON telecom_topups(business_date);
CREATE INDEX idx_telecom_topups_provider_date ON telecom_topups(provider_id, business_date);

CREATE TRIGGER trg_telecom_topups_future_date
BEFORE INSERT ON telecom_topups
WHEN NEW.business_date > date('now','+330 minutes')
BEGIN
  SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED');
END;

CREATE TRIGGER trg_telecom_topups_business_date_immutable
BEFORE UPDATE OF business_date ON telecom_topups
WHEN NEW.business_date <> OLD.business_date
BEGIN
  SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE');
END;

CREATE TRIGGER trg_telecom_topups_posted_at_immutable
BEFORE UPDATE OF posted_at ON telecom_topups
WHEN NEW.posted_at IS NOT OLD.posted_at
BEGIN
  SELECT RAISE(ABORT, 'POSTED_AT_IMMUTABLE');
END;

CREATE TRIGGER trg_telecom_topups_immutable
BEFORE UPDATE OF id, kind, provider_id, amount_cents, notes, client_ref, status, voided_at, void_reason ON telecom_topups
WHEN NEW.id IS NOT OLD.id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.provider_id IS NOT OLD.provider_id
  OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.notes IS NOT OLD.notes
  OR NEW.client_ref IS NOT OLD.client_ref
  OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status
        OR NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
  OR (OLD.status = 'posted' AND NEW.status = 'posted'
        AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.void_reason IS NOT OLD.void_reason))
BEGIN
  SELECT RAISE(ABORT, 'TELECOM_TOPUP_IMMUTABLE');
END;

CREATE TRIGGER trg_telecom_topups_no_delete
BEFORE DELETE ON telecom_topups
BEGIN
  SELECT RAISE(ABORT, 'RECORD_DELETE_FORBIDDEN');
END;
