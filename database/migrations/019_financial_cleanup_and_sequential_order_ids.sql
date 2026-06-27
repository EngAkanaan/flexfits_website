-- 1) Fix: cancelling an order never removed its revenue/profit from the Financials tab.
--    refresh_product_financial_metrics() only ever did INSERT ... ON CONFLICT DO UPDATE, which
--    only touches product_ids that still have a qualifying (dispatched) order. Once an order is
--    canceled, that product can disappear entirely from the computed set -- but the *old* row from
--    before the cancellation was never deleted, so it sat there forever overstating revenue/profit.
--    Fix: every recompute now fully replaces the table (deletes any row no longer backed by a
--    qualifying order, then upserts the fresh numbers), so a canceled order's profit/revenue is
--    completely removed, not just stale.
--
-- 2) New sequential order IDs: ORD-101, ORD-102, ORD-103, ... via a real Postgres sequence
--    (safe under concurrent checkouts, unlike the old `ORD-${Date.now()}` client-side id).

BEGIN;

-- Previously missing: there was no DELETE policy for admin on these two tables, so a raw
-- DELETE (e.g. from the client-side fallback path) would have silently affected 0 rows under RLS.
DROP POLICY IF EXISTS "Financial metrics are deletable by admin" ON product_financial_metrics;
CREATE POLICY "Financial metrics are deletable by admin" ON product_financial_metrics FOR DELETE USING (is_admin());

DROP POLICY IF EXISTS "Financial totals are deletable by admin" ON financial_dashboard_totals;
CREATE POLICY "Financial totals are deletable by admin" ON financial_dashboard_totals FOR DELETE USING (is_admin());

-- Drop first: earlier migrations disagree on this function's return type (VOID vs TABLE), and
-- CREATE OR REPLACE FUNCTION cannot change a return type in place.
DROP FUNCTION IF EXISTS refresh_product_financial_metrics();

CREATE FUNCTION refresh_product_financial_metrics()
RETURNS VOID
SECURITY DEFINER
SET search_path = public, extensions
LANGUAGE plpgsql
AS $$
BEGIN
  -- Remove any row whose product no longer has a qualifying (dispatched) order at all --
  -- this is the case a canceled order's only sale leaves behind otherwise.
  DELETE FROM product_financial_metrics m
  WHERE NOT EXISTS (
    SELECT 1
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.product_id::TEXT = m.product_id
      AND COALESCE(LOWER(o.status), 'pending') IN ('dispatched', 'shipped', 'delivered')
  );

  WITH order_history AS (
    SELECT
      oi.product_id::TEXT AS product_id,
      MAX(COALESCE(NULLIF(oi.product_name, ''), oi.product_id::TEXT))::TEXT AS name_of_product,
      SUM(GREATEST(0, COALESCE(oi.quantity, 0)))::INTEGER AS items_sold,
      SUM(GREATEST(0, COALESCE(oi.quantity, 0)) * GREATEST(0, COALESCE(oi.price, 0)))::DECIMAL(12, 2) AS item_revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE COALESCE(LOWER(o.status), 'pending') IN ('dispatched', 'shipped', 'delivered')
    GROUP BY oi.product_id
  ),
  product_costs AS (
    SELECT
      "Product_ID"::TEXT AS product_id,
      GREATEST(0, COALESCE("Cost", 0))::DECIMAL(10, 2) AS item_cost
    FROM products
  )
  INSERT INTO product_financial_metrics (
    product_id, name_of_product, items_sold, item_price, item_cost, item_revenue, net_profit, calculated_at
  )
  SELECT
    h.product_id,
    h.name_of_product,
    h.items_sold,
    CASE WHEN h.items_sold > 0 THEN (h.item_revenue / h.items_sold)::DECIMAL(10, 2) ELSE 0 END,
    COALESCE(pc.item_cost, 0)::DECIMAL(10, 2),
    h.item_revenue,
    (h.item_revenue - (COALESCE(pc.item_cost, 0) * h.items_sold))::DECIMAL(12, 2),
    NOW()
  FROM order_history h
  LEFT JOIN product_costs pc ON pc.product_id = h.product_id
  WHERE h.product_id IS NOT NULL AND h.product_id <> ''
  ON CONFLICT (product_id) DO UPDATE SET
    name_of_product = EXCLUDED.name_of_product,
    items_sold = EXCLUDED.items_sold,
    item_price = EXCLUDED.item_price,
    item_cost = EXCLUDED.item_cost,
    item_revenue = EXCLUDED.item_revenue,
    net_profit = EXCLUDED.net_profit,
    calculated_at = EXCLUDED.calculated_at;

  DELETE FROM financial_dashboard_totals WHERE id = 'global';
  INSERT INTO financial_dashboard_totals (id, total_revenue, total_net_profit, calculated_at)
  SELECT 'global', COALESCE(SUM(item_revenue), 0), COALESCE(SUM(net_profit), 0), NOW()
  FROM product_financial_metrics;
END;
$$;

-- Re-run immediately so any already-stale rows from past cancellations clear right now.
SELECT refresh_product_financial_metrics();

-- ==================== SEQUENTIAL ORDER IDS ====================

CREATE SEQUENCE IF NOT EXISTS order_number_seq START WITH 101 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION generate_order_id()
RETURNS TEXT
SECURITY DEFINER
SET search_path = public, extensions
LANGUAGE sql
AS $$
  SELECT 'ORD-' || nextval('order_number_seq')::TEXT;
$$;

COMMIT;
