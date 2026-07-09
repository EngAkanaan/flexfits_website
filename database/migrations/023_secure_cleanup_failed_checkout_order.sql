-- Security fix: cleanup_failed_checkout_order could delete ANY pending order.
--
-- The original cleanup_failed_checkout_order(p_order_id TEXT) from migration 016 is
-- SECURITY DEFINER (bypasses RLS) and callable by the anon role, and its only guard was
-- `status = 'pending'`. Combined with sequential/guessable order IDs (migration 019:
-- ORD-101, ORD-102, ...), any unauthenticated visitor could enumerate IDs and delete other
-- shoppers' still-pending orders (cascading to order_items) before the admin dispatched them.
--
-- Fix: bind each order to the checkout's reservation session token (a high-entropy random
-- string held only in the shopper's own localStorage, and unreadable back since orders are
-- admin-only to SELECT), and require that same token to delete the order. Guest checkout keeps
-- working on the anon key; an attacker who guesses an order id still cannot guess the session.

BEGIN;

-- Bind orders to the checkout session. Nullable: orders placed before this migration stay NULL
-- and simply can't be cleaned via this RPC (the admin handles those), which is the safe default.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_session_id TEXT;
-- The orders INSERT policy only checks `status = 'pending'`, so guests may set this column value
-- on insert -- no RLS policy change is required.

-- Remove the vulnerable 1-arg overload. Postgres overloads by signature, so a CREATE OR REPLACE
-- of the new 2-arg version would leave this one in place and still exploitable -- it must be dropped.
DROP FUNCTION IF EXISTS cleanup_failed_checkout_order(text);

-- Ownership-checked replacement: only deletes a still-pending order whose recorded session token
-- matches the caller's.
CREATE OR REPLACE FUNCTION cleanup_failed_checkout_order(p_order_id TEXT, p_session_id TEXT)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public, extensions
LANGUAGE plpgsql
AS $$
BEGIN
  -- Fail closed on a missing/blank session token so it can never match NULL rows.
  IF COALESCE(TRIM(p_session_id), '') = '' THEN
    RETURN false;
  END IF;

  DELETE FROM orders
  WHERE id = p_order_id
    AND status = 'pending'
    AND reservation_session_id = p_session_id;

  RETURN FOUND;
END;
$$;

-- Guest checkout (anon) must still be able to call this; the body now enforces ownership.
-- Dropping the old function dropped its grants, so re-grant explicitly for the new signature.
GRANT EXECUTE ON FUNCTION cleanup_failed_checkout_order(text, text) TO anon, authenticated;

COMMIT;
