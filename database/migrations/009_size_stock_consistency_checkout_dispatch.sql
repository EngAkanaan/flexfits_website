-- Keep size_stock JSONB synchronized during checkout commit and dispatch transitions.
-- Per-size schema: { "size": "40", "stock": 2, "left": 2, "sold": 0 }
-- stock = original amount (fixed, never changes)
-- left = currently available (decreases with orders)
-- sold = total sold (increases with orders)
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
  v_total_stock INTEGER;
  v_total_sold INTEGER;
  v_total_left INTEGER;
  v_committed INTEGER := 0;
  v_size_token TEXT;
  v_size_left INTEGER;
  v_next_size_stock JSONB;
  v_calc_total_left INTEGER;
  v_calc_total_sold INTEGER;
BEGIN
  IF COALESCE(TRIM(p_session_id), '') = '' THEN
    RETURN QUERY SELECT false, 'Session id is required.', 0;
    RETURN;
  END IF;

  IF p_reservation_ids IS NULL OR array_length(p_reservation_ids, 1) IS NULL THEN
    RETURN QUERY SELECT false, 'No reservation ids provided.', 0;
    RETURN;
  END IF;

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

    v_size_token := UPPER(TRIM(COALESCE(v_res.size, '')));
    v_next_size_stock := NULL;

    -- Update per-size stock if size_stock array exists
    IF v_size_token <> '' AND (v_row ? 'size_stock') AND jsonb_typeof(v_row->'size_stock') = 'array' THEN
      SELECT COALESCE((entry->>'left')::INTEGER, 0)
      INTO v_size_left
      FROM jsonb_array_elements(v_row->'size_stock') AS entry
      WHERE UPPER(TRIM(COALESCE(entry->>'size', ''))) = v_size_token
      LIMIT 1;

      IF FOUND THEN
        IF v_size_left < v_res.quantity THEN
          RETURN QUERY SELECT false, 'Not enough stock for selected size.', v_committed;
          RETURN;
        END IF;

        -- Decrement 'left' and increment 'sold' for matching size
        SELECT COALESCE(
          jsonb_agg(
            CASE
              WHEN UPPER(TRIM(COALESCE(entry->>'size', ''))) = v_size_token THEN
                jsonb_set(
                  jsonb_set(entry, '{left}', to_jsonb(GREATEST(0, COALESCE((entry->>'left')::INTEGER, 0) - v_res.quantity))),
                  '{sold}',
                  to_jsonb(GREATEST(0, COALESCE((entry->>'sold')::INTEGER, 0) + v_res.quantity))
                )
              ELSE entry
            END
          ),
          '[]'::jsonb
        )
        INTO v_next_size_stock
        FROM jsonb_array_elements(v_row->'size_stock') AS entry;
      END IF;
    END IF;

    -- Calculate totals for Items_LEFT_in_stock and Items_Sold from size_stock or fallback
    IF v_row ? 'size_stock' AND jsonb_typeof(v_row->'size_stock') = 'array' AND v_next_size_stock IS NOT NULL THEN
      v_calc_total_left := 0;
      v_calc_total_sold := 0;
      SELECT 
        SUM(COALESCE((entry->>'left')::INTEGER, 0)),
        SUM(COALESCE((entry->>'sold')::INTEGER, 0))
      INTO v_calc_total_left, v_calc_total_sold
      FROM jsonb_array_elements(v_next_size_stock) AS entry;
      
      v_total_left := COALESCE(v_calc_total_left, 0);
      v_total_sold := COALESCE(v_calc_total_sold, 0);
    ELSE
      -- Fallback: update total pieces/sold directly
      v_total_stock := GREATEST(0, COALESCE(NULLIF(v_row->>'Stock', '')::INTEGER, COALESCE(NULLIF(v_row->>'pieces', '')::INTEGER, 0)));
      v_total_sold := GREATEST(0, COALESCE(NULLIF(v_row->>'Items_Sold', '')::INTEGER, COALESCE(NULLIF(v_row->>'sold', '')::INTEGER, 0)));
      v_total_left := GREATEST(0, v_total_stock - v_total_sold);

      IF v_total_left < v_res.quantity THEN
        RETURN QUERY SELECT false, 'Not enough stock.', v_committed;
        RETURN;
      END IF;

      v_total_left := v_total_left - v_res.quantity;
      v_total_sold := v_total_sold + v_res.quantity;
    END IF;

    -- Update product totals
    UPDATE products 
    SET
      "Items_LEFT_in_stock" = v_total_left,
      "Items_Sold" = v_total_sold,
      "pieces" = v_total_left,
      "sold" = v_total_sold,
      size_stock = COALESCE(v_next_size_stock, size_stock)
    WHERE ctid = v_ctid;

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
  v_product_row JSONB;
  v_size_token TEXT;
  v_size_left INTEGER;
  v_next_size_stock JSONB;
  v_calc_total_left INTEGER;
  v_calc_total_sold INTEGER;
BEGIN
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
    SELECT to_jsonb(p)
    INTO v_product_row
    FROM products p
    WHERE p."Product_ID" = line_item.product_id
    LIMIT 1
    FOR UPDATE;

    IF v_product_row IS NULL THEN
      RAISE EXCEPTION 'Product % not found during order dispatch.', line_item.product_id;
    END IF;

    v_next_size_stock := NULL;
    v_size_token := UPPER(TRIM(COALESCE(line_item.size, '')));

    -- Update per-size stock if size_stock array exists and size is specified
    IF v_size_token <> '' AND (v_product_row ? 'size_stock') AND jsonb_typeof(v_product_row->'size_stock') = 'array' THEN
      SELECT COALESCE((entry->>'left')::INTEGER, 0)
      INTO v_size_left
      FROM jsonb_array_elements(v_product_row->'size_stock') AS entry
      WHERE UPPER(TRIM(COALESCE(entry->>'size', ''))) = v_size_token
      LIMIT 1;

      IF v_size_left < line_item.total_quantity THEN
        RAISE EXCEPTION 'Not enough stock for size % (need %, have %).', v_size_token, line_item.total_quantity, v_size_left;
      END IF;

      -- Decrement 'left' and increment 'sold' for matching size
      SELECT COALESCE(
        jsonb_agg(
          CASE
            WHEN UPPER(TRIM(COALESCE(entry->>'size', ''))) = v_size_token THEN
              jsonb_set(
                jsonb_set(entry, '{left}', to_jsonb(GREATEST(0, COALESCE((entry->>'left')::INTEGER, 0) - line_item.total_quantity))),
                '{sold}',
                to_jsonb(GREATEST(0, COALESCE((entry->>'sold')::INTEGER, 0) + line_item.total_quantity))
              )
            ELSE entry
          END
        ),
        '[]'::jsonb
      )
      INTO v_next_size_stock
      FROM jsonb_array_elements(v_product_row->'size_stock') AS entry;
    END IF;

    -- Calculate totals from per-size stock
    IF v_product_row ? 'size_stock' AND jsonb_typeof(v_product_row->'size_stock') = 'array' AND v_next_size_stock IS NOT NULL THEN
      v_calc_total_left := 0;
      v_calc_total_sold := 0;
      SELECT 
        SUM(COALESCE((entry->>'left')::INTEGER, 0)),
        SUM(COALESCE((entry->>'sold')::INTEGER, 0))
      INTO v_calc_total_left, v_calc_total_sold
      FROM jsonb_array_elements(v_next_size_stock) AS entry;
      
      UPDATE products
      SET
        "Stock" = COALESCE(v_calc_total_left, 0) + COALESCE(v_calc_total_sold, 0),
        "Items_Sold" = COALESCE(v_calc_total_sold, 0),
        "Status" = CASE WHEN COALESCE(v_calc_total_left, 0) <= 0 THEN 'Temporarily unavailable' ELSE 'In Stock' END,
        size_stock = v_next_size_stock
      WHERE "Product_ID" = line_item.product_id;
    ELSE
      -- Fallback: update total values only
      UPDATE products
      SET
        "Items_Sold" = GREATEST(0, COALESCE("Items_Sold", 0) + line_item.total_quantity),
        "Status" = CASE
          WHEN GREATEST(0, COALESCE("Stock", 0) - GREATEST(0, COALESCE("Items_Sold", 0) + line_item.total_quantity)) <= 0
            THEN 'Temporarily unavailable'
          ELSE 'In Stock'
        END
      WHERE "Product_ID" = line_item.product_id;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
