-- MIGRATION: Fix stock updates to avoid generated column writes
-- - commit_checkout_reservations RPC must not update Items_LEFT_in_stock (generated)
-- - apply_order_dispatch_stock_change trigger must not update Items_LEFT_in_stock (generated)

BEGIN;

CREATE OR REPLACE FUNCTION commit_checkout_reservations(
  p_session_id TEXT,
  p_order_id TEXT,
  p_reservation_ids UUID[]
)
RETURNS TABLE(ok BOOLEAN, message TEXT, committed_count INTEGER) AS $$
DECLARE
  v_now TIMESTAMP WITH TIME ZONE := NOW();
  v_res RECORD;
  v_row JSONB;
  v_ctid TID;
  v_stock INTEGER;
  v_sold INTEGER;
  v_available INTEGER;
  v_committed INTEGER := 0;
  v_set_clause TEXT;
BEGIN
  IF COALESCE(TRIM(p_session_id), '') = '' THEN
    RETURN QUERY SELECT false, 'Session id is required.', 0;
    RETURN;
  END IF;

  IF p_reservation_ids IS NULL OR array_length(p_reservation_ids, 1) IS NULL THEN
    RETURN QUERY SELECT false, 'No reservation ids provided.', 0;
    RETURN;
  END IF;

  -- Release expired rows before committing.
  UPDATE stock_reservations sr
  SET status = 'released', released_at = COALESCE(sr.released_at, v_now)
  WHERE sr.status = 'active' AND sr.expires_at <= v_now;

  FOR v_res IN
    SELECT *
    FROM stock_reservations sr
    WHERE sr.id = ANY(p_reservation_ids)
      AND sr.session_id = p_session_id
      AND sr.status = 'active'
      AND sr.expires_at > v_now
    FOR UPDATE
  LOOP
    SELECT p.ctid, to_jsonb(p)
    INTO v_ctid, v_row
    FROM products p
    WHERE COALESCE(NULLIF(to_jsonb(p)->>'Product_ID', ''), NULLIF(to_jsonb(p)->>'id', '')) = v_res.product_id
    LIMIT 1
    FOR UPDATE;

    IF v_row IS NULL THEN
      RETURN QUERY SELECT false, 'Reserved product not found during checkout.', v_committed;
      RETURN;
    END IF;

    -- Prefer base columns Stock / Items_Sold (works with generated Items_LEFT_in_stock = Stock - Items_Sold).
    IF (v_row ? 'Stock') OR (v_row ? 'Items_Sold') THEN
      v_stock := GREATEST(0, COALESCE(NULLIF(v_row->>'Stock', '')::INTEGER, 0));
      v_sold  := GREATEST(0, COALESCE(NULLIF(v_row->>'Items_Sold', '')::INTEGER, 0));
      v_available := GREATEST(0, v_stock - v_sold);

      IF v_available < v_res.quantity THEN
        RETURN QUERY SELECT false, 'Not enough stock.', v_committed;
        RETURN;
      END IF;

      v_set_clause := '';
      IF v_row ? 'Stock' THEN
        v_set_clause := v_set_clause || CASE WHEN v_set_clause = '' THEN '' ELSE ', ' END || '"Stock" = ' || (v_stock - v_res.quantity);
      END IF;
      IF v_row ? 'Items_Sold' THEN
        v_set_clause := v_set_clause || CASE WHEN v_set_clause = '' THEN '' ELSE ', ' END || '"Items_Sold" = ' || (v_sold + v_res.quantity);
      END IF;
    ELSE
      -- Fallback for older schema that stores remaining stock in pieces and cumulative sold in sold.
      v_stock := GREATEST(0, COALESCE(NULLIF(v_row->>'pieces', '')::INTEGER, 0));
      v_sold  := GREATEST(0, COALESCE(NULLIF(v_row->>'sold', '')::INTEGER, 0));

      IF v_stock < v_res.quantity THEN
        RETURN QUERY SELECT false, 'Not enough stock.', v_committed;
        RETURN;
      END IF;

      v_set_clause := '';
      IF v_row ? 'pieces' THEN
        v_set_clause := v_set_clause || CASE WHEN v_set_clause = '' THEN '' ELSE ', ' END || 'pieces = ' || (v_stock - v_res.quantity);
      END IF;
      IF v_row ? 'sold' THEN
        v_set_clause := v_set_clause || CASE WHEN v_set_clause = '' THEN '' ELSE ', ' END || 'sold = ' || (v_sold + v_res.quantity);
      END IF;
    END IF;

    IF COALESCE(v_set_clause, '') = '' THEN
      RETURN QUERY SELECT false, 'Product stock columns are missing.', v_committed;
      RETURN;
    END IF;

    -- IMPORTANT: Never update "Items_LEFT_in_stock" (generated).
    EXECUTE 'UPDATE products SET ' || v_set_clause || ' WHERE ctid = $1' USING v_ctid;

    UPDATE stock_reservations
    SET status = 'confirmed', confirmed_at = v_now, order_id = p_order_id
    WHERE id = v_res.id;

    v_committed := v_committed + 1;
  END LOOP;

  IF v_committed <> array_length(p_reservation_ids, 1) THEN
    RETURN QUERY SELECT false, 'Some items in your cart have expired.', v_committed;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, 'Checkout stock committed.', v_committed;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_order_dispatch_stock_change()
RETURNS TRIGGER AS $$
DECLARE
  line_item RECORD;
  current_left INTEGER;
  cur_stock INTEGER;
  cur_sold INTEGER;
  next_stock INTEGER;
  next_sold INTEGER;
BEGIN
  -- Only apply inventory mutation when an order is approved/dispatch-confirmed.
  IF LOWER(COALESCE(NEW.status, 'pending')) <> 'shipped' THEN
    RETURN NEW;
  END IF;

  IF LOWER(COALESCE(OLD.status, 'pending')) = 'shipped' THEN
    RETURN NEW;
  END IF;

  FOR line_item IN
    SELECT
      oi.product_id::TEXT AS product_id,
      COALESCE(oi.size, '')::TEXT AS size,
      SUM(GREATEST(0, COALESCE(oi.quantity, 0)))::INTEGER AS total_quantity
    FROM order_items oi
    WHERE oi.order_id = NEW.id
    GROUP BY oi.product_id, oi.size
  LOOP
    -- Lock product row and compute availability from generated column (read-only) if present.
    SELECT COALESCE("Items_LEFT_in_stock", 0)
      INTO current_left
    FROM products
    WHERE "Product_ID" = line_item.product_id
      AND (
        COALESCE(NULLIF(TRIM(COALESCE("SIZE", '')), ''), NULL) IS NULL
        OR EXISTS (
          SELECT 1
          FROM unnest(string_to_array(replace(COALESCE("SIZE", ''), ' ', ''), ',')) AS size_token
          WHERE UPPER(size_token) = UPPER(line_item.size)
        )
      )
    FOR UPDATE;

    IF current_left IS NULL OR current_left < line_item.total_quantity THEN
      RAISE EXCEPTION 'Sorry, this item is currently out of stock.';
    END IF;

    -- Update ONLY base columns. Items_LEFT_in_stock will recompute automatically.
    SELECT COALESCE("Stock", 0), COALESCE("Items_Sold", 0)
    INTO cur_stock, cur_sold
    FROM products
    WHERE "Product_ID" = line_item.product_id
    FOR UPDATE;

    next_stock := GREATEST(0, cur_stock - line_item.total_quantity);
    next_sold  := GREATEST(0, cur_sold + line_item.total_quantity);

    UPDATE products
    SET
      "Stock" = next_stock,
      "Items_Sold" = next_sold,
      "Status" = CASE
        WHEN next_stock - next_sold <= 0 THEN 'Temporarily unavailable'
        ELSE 'In Stock'
      END
    WHERE "Product_ID" = line_item.product_id
      AND (
        COALESCE(NULLIF(TRIM(COALESCE("SIZE", '')), ''), NULL) IS NULL
        OR EXISTS (
          SELECT 1
          FROM unnest(string_to_array(replace(COALESCE("SIZE", ''), ' ', ''), ',')) AS size_token
          WHERE UPPER(size_token) = UPPER(line_item.size)
        )
      );
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;

