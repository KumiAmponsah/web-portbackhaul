-- Expand payment_history_source_valid to accept every `source` value the
-- payment functions legitimately write. The original constraint allowed only
-- SYSTEM / WEBHOOK / ADMIN, which made recordStatusChange inserts fail
-- silently (23514) for API-initiated failures and verify-driven settlements.
-- This is additive: no table or existing policy is recreated.
ALTER TABLE payment_status_history DROP CONSTRAINT IF EXISTS payment_history_source_valid;

ALTER TABLE payment_status_history
  ADD CONSTRAINT payment_history_source_valid
  CHECK (source IN ('SYSTEM', 'WEBHOOK', 'VERIFY', 'ADMIN', 'API', 'PAYOUT', 'MANUAL', 'REFUND'));
