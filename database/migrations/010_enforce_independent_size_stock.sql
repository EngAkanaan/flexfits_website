-- Enforce independent size-level stock for reservation, checkout commit, and dispatch.
-- Rule: each size has its own available bucket (`left`), and product totals are sums of all size `left`.

BEGIN;

CREATE OR REPLACE FUNCTION reserve_product_stock_fcfs(
  p_session_id TEXT,
  p_product_id TEXT,
  p_size TEXT,
  p_quantity INTEGER,
  p_ttl_seconds INTEGER DEFAULT 600,
  p_existing_reservation_id UUID DEFAULT NULL
)
RETURNS TABLE (
  ok BOOLEAN,
  message TEXT,
  reservation_id UUID,
  expires_at TIMESTAMP WITH TIME ZONE,
  available_after INTEGER
) AS $$
DECLARE
  v_row JSONB;
  v_size_token TEXT;
  v_size_left INTEGER;
  v_has_size_stock BOOLEAN;
  v_existing_qty INTEGER := 0;
  v_reserved_others INTEGER := 0;
  v_target_qty INTEGER;
  v_now TIMESTAMP WITH TIME ZONE := NOW();
  v_exp TIMESTAMP WITH TIME ZONE;
  v_reservation_id UUID;
  v_total_left INTEGER;
BEGIN
  IF COALESCE(TRIM(p_session_id), '') = '' THEN
    RETURN QUERY SELECT false, 'Reservation session is required.', NULL::UUID, NULL::TIMESTAMPTZ, 0;
    RETURN;
  END IF;

  IF COALESCE(TRIM(p_product_id), '') = '' OR COALESCE(TRIM(p_size), '') = '' THEN
    RETURN QUERY SELECT false, 'Product and size are required.', NULL::UUID, NULL::TIMESTAMPTZ, 0;
    RETURN;
  END IF;

  IF COALESCE(p_quantity, 0) <= 0 THEN
    RETURN QUERY SELECT false, 'Reservation quantity must be positive.', NULL::UUID, NULL::TIMESTAMPTZ, 0;
    RETURN;
  END IF;

  v_size_token := UPPER(TRIM(COALESCE(p_size, '')));

  UPDATE stock_reservations sr
  SET status = 'released', released_at = COALESCE(sr.released_at, v_now)
  WHERE sr.status = 'active' AND sr.expires_at <= v_now;

  SELECT to_jsonb(p)
  INTO v_row
  FROM products p
  WHERE COALESCE(NULLIF(to_jsonb(p)->>'Product_ID', ''), NULLIF(to_jsonb(p)->>'id', '')) = p_product_id
  LIMIT 1
  FOR UPDATE;

  IF v_row IS NULL THEN
    RETURN QUERY SELECT false, 'Product not found.', NULL::UUID, NULL::TIMESTAMPTZ, 0;
    RETURN;
  END IF;

  v_has_size_stock := (v_row ? 'size_stock') AND jsonb_typeof(v_row->'size_stock') = 'array';

  IF p_existing_reservation_id IS NOT NULL THEN
    SELECT COALESCE(quantity, 0)
    INTO v_existing_qty
    FROM stock_reservations sr
    WHERE sr.id = p_existing_reservation_id
      AND sr.session_id = p_session_id
      AND sr.product_id = p_product_id
      AND LOWER(COALESCE(sr.size, '')) = LOWER(p_size)
      AND sr.status = 'active'
      AND sr.expires_at > v_now
    FOR UPDATE;
  END IF;

  v_target_qty := CASE WHEN p_existing_reservation_id IS NULL THEN p_quantity ELSE v_existing_qty + p_quantity END;

  IF v_has_size_stock THEN
    SELECT COALESCE((entry->>'left')::INTEGER, 0)
    INTO v_size_left
    FROM jsonb_array_elements(v_row->'size_stock') AS entry
    WHERE UPPER(TRIM(COALESCE(entry->>'size', ''))) = v_size_token
    LIMIT 1;

    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 'Selected size is unavailable.', NULL::UUID, NULL::TIMESTAMPTZ, 0;
      RETURN;
    END IF;

    SELECT COALESCE(SUM(quantity), 0)
    INTO v_reserved_others
    FROM stock_reservations sr
    WHERE sr.product_id = p_product_id
      AND LOWER(COALESCE(sr.size, '')) = LOWER(p_size)
      AND sr.status = 'active'
      AND sr.expires_at > v_now
      AND (p_existing_reservation_id IS NULL OR sr.id <> p_existing_reservation_id);

    IF v_size_left - v_reserved_others < v_target_qty THEN
      RETURN QUERY SELECT false, 'Reserved by another shopper. Please reduce quantity.', NULL::UUID, NULL::TIMESTAMPTZ, GREATEST(0, v_size_left - v_reserved_others);
      RETURN;
    END IF;

    v_total_left := GREATEST(0, v_size_left - v_reserved_others - v_target_qty);
  ELSE
    v_total_left := GREATEST(
      0,
      COALESCE(
        NULLIF(v_row->>'Items_LEFT_in_stock', '')::INTEGER,
        NULLIF(v_row->>'pieces', '')::INTEGER,
        NULLIF(v_row->>'Stock', '')::INTEGER,
        0
      )
    );

    SELECT COALESCE(SUM(quantity), 0)
    INTO v_reserved_others
    FROM stock_reservations sr
    WHERE sr.product_id = p_product_id
      AND LOWER(COALESCE(sr.size, '')) = LOWER(p_size)
      AND sr.status = 'active'
      AND sr.expires_at > v_now
      AND (p_existing_reservation_id IS NULL OR sr.id <> p_existing_reservation_id);

    IF v_total_left - v_reserved_others < v_target_qty THEN
      RETURN QUERY SELECT false, 'Reserved by another shopper. Please reduce quantity.', NULL::UUID, NULL::TIMESTAMPTZ, GREATEST(0, v_total_left - v_reserved_others);
      RETURN;
    END IF;

    v_total_left := GREATEST(0, v_total_left - v_reserved_others - v_target_qty);
  END IF;

  v_exp := v_now + (GREATEST(60, COALESCE(p_ttl_seconds, 600)) || ' seconds')::INTERVAL;

  IF p_existing_reservation_id IS NULL THEN
    INSERT INTO stock_reservations (
      product_id, size, quantity, session_id, status, reserved_at, expires_at
    ) VALUES (
      p_product_id, p_size, p_quantity, p_session_id, 'active', v_now, v_exp
    )
    RETURNING id INTO v_reservation_id;
  ELSE
    UPDATE stock_reservations sr
    SET
      quantity = v_target_qty,
      reserved_at = v_now,
      expires_at = v_exp,
      status = 'active',
      released_at = NULL,
      confirmed_at = NULL,
      order_id = NULL
    WHERE sr.id = p_existing_reservation_id
      AND sr.session_id = p_session_id
      AND sr.status = 'active'
    RETURNING id INTO v_reservation_id;

    IF v_reservation_id IS NULL THEN
      RETURN QUERY SELECT false, 'Existing reservation is no longer valid.', NULL::UUID, NULL::TIMESTAMPTZ, v_total_left;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  SELECT true, 'Reserved successfully.', v_reservation_id, v_exp, v_total_left;
END;
$$ LANGUAGE plpgsql;

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

    IF (v_row ? 'size_stock') AND jsonb_typeof(v_row->'size_stock') = 'array' THEN
      IF v_size_token = '' THEN
        RETURN QUERY SELECT false, 'Selected size is required.', v_committed;
        RETURN;
      END IF;

      SELECT COALESCE((entry->>'left')::INTEGER, 0)
      INTO v_size_left
      FROM jsonb_array_elements(v_row->'size_stock') AS entry
      WHERE UPPER(TRIM(COALESCE(entry->>'size', ''))) = v_size_token
      LIMIT 1;

      IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'Selected size is unavailable.', v_committed;
        RETURN;
      END IF;

      IF v_size_left < v_res.quantity THEN
        RETURN QUERY SELECT false, 'Not enough stock for selected size.', v_committed;
        RETURN;
      END IF;

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

      SELECT
        SUM(COALESCE((entry->>'left')::INTEGER, 0)),
        SUM(COALESCE((entry->>'sold')::INTEGER, 0))
      INTO v_calc_total_left, v_calc_total_sold
      FROM jsonb_array_elements(v_next_size_stock) AS entry;

      v_total_left := COALESCE(v_calc_total_left, 0);
      v_total_sold := COALESCE(v_calc_total_sold, 0);
    ELSE
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

    UPDATE products
    SET
      "Items_LEFT_in_stock" = v_total_left,
      "Items_Sold" = v_total_sold,
      "pieces" = v_total_left,
      "sold" = v_total_sold,
      "Status" = CASE WHEN v_total_left <= 0 THEN 'Temporarily unavailable' ELSE 'In Stock' END,
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

    IF (v_product_row ? 'size_stock') AND jsonb_typeof(v_product_row->'size_stock') = 'array' THEN
      IF v_size_token = '' THEN
        RAISE EXCEPTION 'Selected size is required for product % during dispatch.', line_item.product_id;
      END IF;

      SELECT COALESCE((entry->>'left')::INTEGER, 0)
      INTO v_size_left
      FROM jsonb_array_elements(v_product_row->'size_stock') AS entry
      WHERE UPPER(TRIM(COALESCE(entry->>'size', ''))) = v_size_token
      LIMIT 1;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Selected size % is unavailable for product %.', v_size_token, line_item.product_id;
      END IF;

      IF v_size_left < line_item.total_quantity THEN
        RAISE EXCEPTION 'Not enough stock for size % (need %, have %).', v_size_token, line_item.total_quantity, v_size_left;
      END IF;

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

      SELECT
        SUM(COALESCE((entry->>'left')::INTEGER, 0)),
        SUM(COALESCE((entry->>'sold')::INTEGER, 0))
      INTO v_calc_total_left, v_calc_total_sold
      FROM jsonb_array_elements(v_next_size_stock) AS entry;

      UPDATE products
      SET
        "Items_LEFT_in_stock" = COALESCE(v_calc_total_left, 0),
        "Items_Sold" = COALESCE(v_calc_total_sold, 0),
        "pieces" = COALESCE(v_calc_total_left, 0),
        "sold" = COALESCE(v_calc_total_sold, 0),
        "Status" = CASE WHEN COALESCE(v_calc_total_left, 0) <= 0 THEN 'Temporarily unavailable' ELSE 'In Stock' END,
        size_stock = v_next_size_stock
      WHERE "Product_ID" = line_item.product_id;
    ELSE
      UPDATE products
      SET
        "Items_LEFT_in_stock" = GREATEST(0, COALESCE("Items_LEFT_in_stock", 0) - line_item.total_quantity),
        "Items_Sold" = GREATEST(0, COALESCE("Items_Sold", 0) + line_item.total_quantity),
        "pieces" = GREATEST(0, COALESCE("pieces", 0) - line_item.total_quantity),
        "sold" = GREATEST(0, COALESCE("sold", 0) + line_item.total_quantity),
        "Status" = CASE WHEN GREATEST(0, COALESCE("Items_LEFT_in_stock", 0) - line_item.total_quantity) <= 0 THEN 'Temporarily unavailable' ELSE 'In Stock' END
      WHERE "Product_ID" = line_item.product_id;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
