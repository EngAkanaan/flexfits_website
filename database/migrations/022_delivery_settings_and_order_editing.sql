-- Delivery settings + admin order editing.
--
-- 1) store_settings: single-row table holding the configurable delivery fee and the
--    free-delivery threshold (NULL = promo off, 0 = always free, N = free when the
--    items subtotal is >= N). Public SELECT (guest checkout needs it), admin-only writes.
-- 2) orders.delivery_fee: each order records the fee it was charged, so editing an
--    order later can recompute total = items subtotal + delivery_fee. Orders placed
--    before this migration all used the fixed $5 fee, so they are backfilled with 5.
-- 3) admin_remove_order_item / admin_set_order_delivery_fee: SECURITY DEFINER RPCs
--    (guarded by is_admin()) so each edit is one atomic transaction: restore stock the
--    same way order cancellation does, release reservations, delete the line, and keep
--    orders.total consistent. Editing is only allowed while the order is still pending.

BEGIN;

-- ==================== STORE SETTINGS ====================

CREATE TABLE IF NOT EXISTS store_settings (
  id TEXT PRIMARY KEY,
  delivery_fee NUMERIC(10, 2) NOT NULL DEFAULT 5 CHECK (delivery_fee >= 0),
  free_delivery_threshold NUMERIC(10, 2) CHECK (free_delivery_threshold IS NULL OR free_delivery_threshold >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE store_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Store settings are viewable by everyone" ON store_settings;
DROP POLICY IF EXISTS "Store settings are insertable by admin" ON store_settings;
DROP POLICY IF EXISTS "Store settings are updatable by admin" ON store_settings;

CREATE POLICY "Store settings are viewable by everyone" ON store_settings FOR SELECT USING (true);
CREATE POLICY "Store settings are insertable by admin" ON store_settings FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Store settings are updatable by admin" ON store_settings FOR UPDATE USING (is_admin());

DROP TRIGGER IF EXISTS update_store_settings_updated_at ON store_settings;
CREATE TRIGGER update_store_settings_updated_at
  BEFORE UPDATE ON store_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

INSERT INTO store_settings (id, delivery_fee, free_delivery_threshold)
VALUES ('global', 5, NULL)
ON CONFLICT (id) DO NOTHING;

-- The app listens for live changes on this table; new tables are not added to the
-- realtime publication automatically. Safe to skip if realtime is configured elsewhere.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE store_settings;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END
$$;

-- ==================== ORDERS: DELIVERY FEE COLUMN ====================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'delivery_fee'
  ) THEN
    ALTER TABLE orders ADD COLUMN delivery_fee NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0);
    -- Every order placed before this migration was charged the fixed $5 fee.
    UPDATE orders SET delivery_fee = 5;
  END IF;
END
$$;

-- ==================== STOCK RESTORE HELPER ====================
-- Mirrors one line-item iteration of apply_order_cancel_stock_restore (migration 013):
-- decrement sold for the selected size (or the flat Items_Sold), recompute left,
-- resync product totals, and preserve manual merchandising statuses.

CREATE OR REPLACE FUNCTION restore_order_line_stock(
  p_product_id TEXT,
  p_size TEXT,
  p_quantity INTEGER
)
RETURNS VOID AS $$
DECLARE
  v_product_row JSONB;
  v_size_token TEXT;
  v_has_size_stock BOOLEAN;
  v_next_size_stock JSONB;
  v_entry JSONB;
  v_entry_size TEXT;
  v_entry_stock INTEGER;
  v_entry_sold INTEGER;
  v_entry_left INTEGER;
  v_size_matched BOOLEAN;
  v_total_stock INTEGER;
  v_total_sold INTEGER;
  v_total_left INTEGER;
  v_current_status TEXT;
  v_normalized_status TEXT;
  v_next_status TEXT;
BEGIN
  IF COALESCE(p_quantity, 0) <= 0 THEN
    RETURN;
  END IF;

  SELECT to_jsonb(p)
  INTO v_product_row
  FROM products p
  WHERE p."Product_ID" = p_product_id
  LIMIT 1
  FOR UPDATE;

  IF v_product_row IS NULL THEN
    RAISE EXCEPTION 'Product % not found while restoring stock.', p_product_id;
  END IF;

  v_current_status := COALESCE(v_product_row->>'Status', v_product_row->>'status', '');
  v_normalized_status := LOWER(TRIM(v_current_status));

  v_has_size_stock := (v_product_row ? 'size_stock') AND jsonb_typeof(v_product_row->'size_stock') = 'array';
  v_size_token := UPPER(TRIM(COALESCE(p_size, '')));

  IF v_has_size_stock THEN
    IF v_size_token = '' THEN
      RAISE EXCEPTION 'Selected size is required for product % while restoring stock.', p_product_id;
    END IF;

    v_next_size_stock := '[]'::jsonb;
    v_size_matched := false;

    FOR v_entry IN
      SELECT value
      FROM jsonb_array_elements(v_product_row->'size_stock')
    LOOP
      v_entry_size := UPPER(TRIM(COALESCE(v_entry->>'size', '')));
      v_entry_stock := GREATEST(
        0,
        COALESCE(
          NULLIF(v_entry->>'stock', '')::INTEGER,
          GREATEST(0, COALESCE(NULLIF(v_entry->>'left', '')::INTEGER, 0) + COALESCE(NULLIF(v_entry->>'sold', '')::INTEGER, 0))
        )
      );
      v_entry_sold := LEAST(v_entry_stock, GREATEST(0, COALESCE(NULLIF(v_entry->>'sold', '')::INTEGER, 0)));

      IF v_entry_size = v_size_token THEN
        v_size_matched := true;
        v_entry_sold := GREATEST(0, v_entry_sold - p_quantity);
      END IF;

      v_entry_left := GREATEST(0, v_entry_stock - v_entry_sold);

      v_next_size_stock := v_next_size_stock || jsonb_build_array(
        jsonb_build_object(
          'size', COALESCE(NULLIF(TRIM(COALESCE(v_entry->>'size', '')), ''), v_size_token),
          'stock', v_entry_stock,
          'sold', v_entry_sold,
          'left', v_entry_left
        )
      );
    END LOOP;

    IF NOT v_size_matched THEN
      RAISE EXCEPTION 'Selected size % is unavailable for product %.', v_size_token, p_product_id;
    END IF;

    SELECT
      COALESCE(SUM(GREATEST(0, COALESCE(NULLIF(entry->>'stock', '')::INTEGER, 0))), 0),
      COALESCE(SUM(GREATEST(0, COALESCE(NULLIF(entry->>'sold', '')::INTEGER, 0))), 0),
      COALESCE(SUM(GREATEST(0, COALESCE(NULLIF(entry->>'left', '')::INTEGER, 0))), 0)
    INTO v_total_stock, v_total_sold, v_total_left
    FROM jsonb_array_elements(v_next_size_stock) AS entry;

    v_next_status := CASE
      WHEN v_normalized_status IN ('discontinued', 'coming soon') THEN v_current_status
      WHEN v_total_left <= 0 THEN 'Out of Stock'
      ELSE 'Active'
    END;

    UPDATE products
    SET
      "Stock" = v_total_stock,
      "Items_Sold" = v_total_sold,
      "Status" = v_next_status,
      size_stock = v_next_size_stock
    WHERE "Product_ID" = p_product_id;
  ELSE
    v_total_stock := GREATEST(0, COALESCE(NULLIF(v_product_row->>'Stock', '')::INTEGER, 0));
    v_total_sold := GREATEST(0, COALESCE(NULLIF(v_product_row->>'Items_Sold', '')::INTEGER, 0));
    v_total_sold := GREATEST(0, v_total_sold - p_quantity);
    v_total_left := GREATEST(0, v_total_stock - v_total_sold);

    v_next_status := CASE
      WHEN v_normalized_status IN ('discontinued', 'coming soon') THEN v_current_status
      WHEN v_total_left <= 0 THEN 'Out of Stock'
      ELSE 'Active'
    END;

    UPDATE products
    SET
      "Items_Sold" = v_total_sold,
      "Status" = v_next_status
    WHERE "Product_ID" = p_product_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ==================== ADMIN: REMOVE ORDER ITEM ====================

CREATE OR REPLACE FUNCTION admin_remove_order_item(
  p_order_id TEXT,
  p_product_id TEXT,
  p_size TEXT
)
RETURNS NUMERIC
SECURITY DEFINER
SET search_path = public, extensions
LANGUAGE plpgsql
AS $$
DECLARE
  v_order RECORD;
  v_removed_qty INTEGER := 0;
  v_matching_lines INTEGER := 0;
  v_total_lines INTEGER := 0;
  v_items_subtotal NUMERIC := 0;
  v_new_total NUMERIC := 0;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the admin can edit orders.';
  END IF;

  SELECT * INTO v_order
  FROM orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % was not found.', p_order_id;
  END IF;

  IF LOWER(COALESCE(v_order.status, 'pending')) <> 'pending' THEN
    RAISE EXCEPTION 'Only pending orders can be edited.';
  END IF;

  SELECT
    COUNT(*) FILTER (
      WHERE oi.product_id = p_product_id
        AND UPPER(TRIM(COALESCE(oi.size, ''))) = UPPER(TRIM(COALESCE(p_size, '')))
    ),
    COUNT(*),
    COALESCE(SUM(GREATEST(0, COALESCE(oi.quantity, 0))) FILTER (
      WHERE oi.product_id = p_product_id
        AND UPPER(TRIM(COALESCE(oi.size, ''))) = UPPER(TRIM(COALESCE(p_size, '')))
    ), 0)
  INTO v_matching_lines, v_total_lines, v_removed_qty
  FROM order_items oi
  WHERE oi.order_id = p_order_id;

  IF v_matching_lines = 0 THEN
    RAISE EXCEPTION 'This item is no longer part of the order.';
  END IF;

  IF v_matching_lines >= v_total_lines THEN
    RAISE EXCEPTION 'An order must keep at least one item. Cancel the order instead.';
  END IF;

  -- Put the units back into sellable stock (checkout committed them when the order was placed).
  PERFORM restore_order_line_stock(p_product_id, p_size, v_removed_qty);

  -- Release any confirmed reservations attached to the removed lines.
  UPDATE stock_reservations sr
  SET status = 'released', released_at = COALESCE(sr.released_at, NOW())
  WHERE sr.status IN ('active', 'confirmed')
    AND sr.id IN (
      SELECT oi.reservation_id
      FROM order_items oi
      WHERE oi.order_id = p_order_id
        AND oi.product_id = p_product_id
        AND UPPER(TRIM(COALESCE(oi.size, ''))) = UPPER(TRIM(COALESCE(p_size, '')))
        AND oi.reservation_id IS NOT NULL
    );

  DELETE FROM order_items oi
  WHERE oi.order_id = p_order_id
    AND oi.product_id = p_product_id
    AND UPPER(TRIM(COALESCE(oi.size, ''))) = UPPER(TRIM(COALESCE(p_size, '')));

  SELECT COALESCE(SUM(GREATEST(0, COALESCE(oi.quantity, 0)) * GREATEST(0, COALESCE(oi.price, 0))), 0)
  INTO v_items_subtotal
  FROM order_items oi
  WHERE oi.order_id = p_order_id;

  v_new_total := v_items_subtotal + GREATEST(0, COALESCE(v_order.delivery_fee, 0));

  UPDATE orders
  SET total = v_new_total
  WHERE id = p_order_id;

  RETURN v_new_total;
END;
$$;

-- ==================== ADMIN: SET ORDER DELIVERY FEE ====================

CREATE OR REPLACE FUNCTION admin_set_order_delivery_fee(
  p_order_id TEXT,
  p_delivery_fee NUMERIC
)
RETURNS NUMERIC
SECURITY DEFINER
SET search_path = public, extensions
LANGUAGE plpgsql
AS $$
DECLARE
  v_order RECORD;
  v_items_subtotal NUMERIC := 0;
  v_fee NUMERIC;
  v_new_total NUMERIC := 0;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the admin can edit orders.';
  END IF;

  v_fee := COALESCE(p_delivery_fee, 0);
  IF v_fee < 0 THEN
    RAISE EXCEPTION 'Delivery fee cannot be negative.';
  END IF;

  SELECT * INTO v_order
  FROM orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % was not found.', p_order_id;
  END IF;

  IF LOWER(COALESCE(v_order.status, 'pending')) <> 'pending' THEN
    RAISE EXCEPTION 'Only pending orders can be edited.';
  END IF;

  SELECT COALESCE(SUM(GREATEST(0, COALESCE(oi.quantity, 0)) * GREATEST(0, COALESCE(oi.price, 0))), 0)
  INTO v_items_subtotal
  FROM order_items oi
  WHERE oi.order_id = p_order_id;

  v_new_total := v_items_subtotal + v_fee;

  UPDATE orders
  SET delivery_fee = v_fee, total = v_new_total
  WHERE id = p_order_id;

  RETURN v_new_total;
END;
$$;

COMMIT;
