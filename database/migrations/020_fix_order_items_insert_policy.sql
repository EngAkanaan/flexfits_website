-- Fix: guest checkout can never insert order_items.
--
-- The order_items INSERT policy from migration 016 checks:
--   EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND o.status = 'pending')
-- but that subquery against `orders` is itself subject to `orders`' own RLS SELECT policy,
-- which is admin-only (is_admin()). So for a guest/anon caller, the subquery always returns
-- zero rows -- the EXISTS check can never be true, no matter the order's real status. Guest
-- checkout was broken from the moment migration 016 was applied.
--
-- Fix: look up the parent order's status through a SECURITY DEFINER helper function, which
-- runs with elevated privileges and bypasses RLS on `orders` for this one narrow lookup. It only
-- ever returns a boolean (true/false for "is this specific order_id pending"), so it can't be used
-- to read or enumerate any other order's data -- the guest already knows the order_id, since they
-- just created it moments earlier in the same checkout.

BEGIN;

CREATE OR REPLACE FUNCTION order_is_pending(p_order_id TEXT)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public, extensions
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM orders o WHERE o.id = p_order_id AND o.status = 'pending');
$$;

DROP POLICY IF EXISTS "Order items are insertable for pending orders" ON order_items;
CREATE POLICY "Order items are insertable for pending orders" ON order_items FOR INSERT WITH CHECK (
  order_is_pending(order_items.order_id)
);

COMMIT;
