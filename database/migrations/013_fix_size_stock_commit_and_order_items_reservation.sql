-- Enforce size_stock as canonical stock source during checkout/cancel and align order_items schema.
-- Rules enforced:
-- 1) Update only the selected size entry when committing/restoring stock.
-- 2) Keep per-size invariant: left = stock - sold.
-- 3) Keep product totals synced as sums across all size entries.
-- 4) Preserve manual merchandising statuses (Discontinued, Coming Soon).

BEGIN;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS reservation_id UUID;

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
  v_now TIMESTAMP WITH TIME ZONE := NOW();
  v_exp TIMESTAMP WITH TIME ZONE;
  v_size_token TEXT;
  v_has_size_stock BOOLEAN;
  v_size_left INTEGER := 0;
  v_total_left INTEGER := 0;
  v_existing_qty INTEGER := 0;
  v_reserved_others INTEGER := 0;
  v_target_qty INTEGER;
  v_reservation_id UUID;
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

  v_size_token := UPPER(TRIM(COALESCE(p_size, '')));
  v_has_size_stock := (v_row ? 'size_stock') AND jsonb_typeof(v_row->'size_stock') = 'array';

  IF p_existing_reservation_id IS NOT NULL THEN
    SELECT COALESCE(sr.quantity, 0)
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
    SELECT GREATEST(
      0,
      COALESCE(
        NULLIF(entry->>'left', '')::INTEGER,
        GREATEST(0, COALESCE(NULLIF(entry->>'stock', '')::INTEGER, 0) - COALESCE(NULLIF(entry->>'sold', '')::INTEGER, 0)),
        0
      )
    )
    INTO v_size_left
    FROM jsonb_array_elements(v_row->'size_stock') AS entry
    WHERE UPPER(TRIM(COALESCE(entry->>'size', ''))) = v_size_token
    LIMIT 1;

    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 'Selected size is unavailable.', NULL::UUID, NULL::TIMESTAMPTZ, 0;
      RETURN;
    END IF;

    SELECT COALESCE(SUM(sr.quantity), 0)
    INTO v_reserved_others
    FROM stock_reservations sr
    WHERE sr.product_id = p_product_id
      AND LOWER(COALESCE(sr.size, '')) = LOWER(p_size)
      AND sr.status = 'active'
      AND sr.expires_at > v_now
      AND (p_existing_reservation_id IS NULL OR sr.id <> p_existing_reservation_id);

    v_total_left := GREATEST(0, v_size_left - v_reserved_others);
  ELSE
    v_total_left := GREATEST(
      0,
      COALESCE(
        NULLIF(v_row->>'Items_LEFT_in_stock', '')::INTEGER,
        GREATEST(
          0,
          COALESCE(NULLIF(v_row->>'Stock', '')::INTEGER, 0) - COALESCE(NULLIF(v_row->>'Items_Sold', '')::INTEGER, 0)
        ),
        0
      )
    );

    SELECT COALESCE(SUM(sr.quantity), 0)
    INTO v_reserved_others
    FROM stock_reservations sr
    WHERE sr.product_id = p_product_id
      AND LOWER(COALESCE(sr.size, '')) = LOWER(p_size)
      AND sr.status = 'active'
      AND sr.expires_at > v_now
      AND (p_existing_reservation_id IS NULL OR sr.id <> p_existing_reservation_id);

    v_total_left := GREATEST(0, v_total_left - v_reserved_others);
  END IF;

  IF v_total_left < v_target_qty THEN
    RETURN QUERY SELECT false, 'Reserved by another shopper. Please reduce quantity.', NULL::UUID, NULL::TIMESTAMPTZ, v_total_left;
    RETURN;
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

  RETURN QUERY SELECT true, 'Reserved successfully.', v_reservation_id, v_exp, GREATEST(0, v_total_left - v_target_qty);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION extend_stock_reservation(
  p_session_id TEXT,
  p_reservation_id UUID,
  p_extend_seconds INTEGER DEFAULT 120
)
RETURNS TABLE(
  ok BOOLEAN,
  message TEXT,
  expires_at TIMESTAMP WITH TIME ZONE
) AS $$
DECLARE
  v_now TIMESTAMP WITH TIME ZONE := NOW();
  v_new_exp TIMESTAMP WITH TIME ZONE;
BEGIN
  v_new_exp := v_now + (GREATEST(30, COALESCE(p_extend_seconds, 120)) || ' seconds')::INTERVAL;

  UPDATE stock_reservations sr
  SET
    expires_at = v_new_exp,
    reserved_at = COALESCE(sr.reserved_at, v_now)
  WHERE sr.id = p_reservation_id
    AND sr.session_id = p_session_id
    AND sr.status = 'active'
    AND sr.expires_at >= v_now - INTERVAL '120 seconds';

  IF FOUND THEN
    RETURN QUERY SELECT true, 'Reservation extended.', v_new_exp;
  ELSE
    RETURN QUERY SELECT false, 'Reservation cannot be extended.', NULL::TIMESTAMPTZ;
  END IF;
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
  v_reservation_ids UUID[];
  v_expected_count INTEGER := 0;
  v_row JSONB;
  v_ctid TID;
  v_committed INTEGER := 0;
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
  IF COALESCE(TRIM(p_session_id), '') = '' THEN
    RETURN QUERY SELECT false, 'Session id is required.', 0;
    RETURN;
  END IF;

  IF p_reservation_ids IS NULL OR array_length(p_reservation_ids, 1) IS NULL THEN
    RETURN QUERY SELECT false, 'No reservation ids provided.', 0;
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT id), ARRAY[]::UUID[])
  INTO v_reservation_ids
  FROM unnest(p_reservation_ids) AS id;

  v_expected_count := COALESCE(array_length(v_reservation_ids, 1), 0);
  IF v_expected_count = 0 THEN
    RETURN QUERY SELECT false, 'No reservation ids provided.', 0;
    RETURN;
  END IF;

  UPDATE stock_reservations sr
  SET status = 'released', released_at = COALESCE(sr.released_at, v_now)
  WHERE sr.status = 'active' AND sr.expires_at <= v_now;

  FOR v_res IN
    SELECT *
    FROM stock_reservations sr
    WHERE sr.id = ANY(v_reservation_ids)
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

    v_current_status := COALESCE(v_row->>'Status', v_row->>'status', '');
    v_normalized_status := LOWER(TRIM(v_current_status));

    v_has_size_stock := (v_row ? 'size_stock') AND jsonb_typeof(v_row->'size_stock') = 'array';
    v_size_token := UPPER(TRIM(COALESCE(v_res.size, '')));

    IF v_has_size_stock THEN
      IF v_size_token = '' THEN
        RETURN QUERY SELECT false, 'Selected size is required for this product.', v_committed;
        RETURN;
      END IF;

      v_next_size_stock := '[]'::jsonb;
      v_size_matched := false;

      FOR v_entry IN
        SELECT value
        FROM jsonb_array_elements(v_row->'size_stock')
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
        v_entry_left := GREATEST(0, v_entry_stock - v_entry_sold);

        IF v_entry_size = v_size_token THEN
          v_size_matched := true;

          IF v_entry_left < v_res.quantity THEN
            RETURN QUERY SELECT false, 'Not enough stock for selected size.', v_committed;
            RETURN;
          END IF;

          v_entry_sold := LEAST(v_entry_stock, v_entry_sold + v_res.quantity);
          v_entry_left := GREATEST(0, v_entry_stock - v_entry_sold);
        END IF;

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
        RETURN QUERY SELECT false, 'Selected size is unavailable for this product.', v_committed;
        RETURN;
      END IF;

      SELECT
        COALESCE(SUM(GREATEST(0, COALESCE(NULLIF(entry->>'stock', '')::INTEGER, 0))), 0),
        COALESCE(SUM(GREATEST(0, COALESCE(NULLIF(entry->>'sold', '')::INTEGER, 0))), 0),
        COALESCE(SUM(GREATEST(0, COALESCE(NULLIF(entry->>'left', '')::INTEGER, 0))), 0)
      INTO v_total_stock, v_total_sold, v_total_left
      FROM jsonb_array_elements(v_next_size_stock) AS entry;
    ELSE
      v_total_stock := GREATEST(0, COALESCE(NULLIF(v_row->>'Stock', '')::INTEGER, 0));
      v_total_sold := GREATEST(0, COALESCE(NULLIF(v_row->>'Items_Sold', '')::INTEGER, 0));
      v_total_left := GREATEST(0, v_total_stock - v_total_sold);

      IF v_total_left < v_res.quantity THEN
        RETURN QUERY SELECT false, 'Not enough stock.', v_committed;
        RETURN;
      END IF;

      v_total_sold := v_total_sold + v_res.quantity;
      v_total_left := GREATEST(0, v_total_stock - v_total_sold);
      v_next_size_stock := NULL;
    END IF;

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
      size_stock = COALESCE(v_next_size_stock, size_stock)
    WHERE ctid = v_ctid;

    UPDATE stock_reservations
    SET status = 'confirmed', confirmed_at = v_now, order_id = p_order_id
    WHERE id = v_res.id;

    v_committed := v_committed + 1;
  END LOOP;

  IF v_committed <> v_expected_count THEN
    RETURN QUERY SELECT false, 'Some items in your cart have expired.', v_committed;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, 'Checkout stock committed.', v_committed;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_order_cancel_stock_restore()
RETURNS TRIGGER AS $$
DECLARE
  line_item RECORD;
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
  IF LOWER(COALESCE(NEW.status, 'pending')) NOT IN ('canceled', 'cancelled') THEN
    RETURN NEW;
  END IF;

  IF LOWER(COALESCE(OLD.status, 'pending')) IN ('canceled', 'cancelled') THEN
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
      RAISE EXCEPTION 'Product % not found during order cancel.', line_item.product_id;
    END IF;

    v_current_status := COALESCE(v_product_row->>'Status', v_product_row->>'status', '');
    v_normalized_status := LOWER(TRIM(v_current_status));

    v_has_size_stock := (v_product_row ? 'size_stock') AND jsonb_typeof(v_product_row->'size_stock') = 'array';
    v_size_token := UPPER(TRIM(COALESCE(line_item.size, '')));

    IF v_has_size_stock THEN
      IF v_size_token = '' THEN
        RAISE EXCEPTION 'Selected size is required for product % during cancel.', line_item.product_id;
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
          v_entry_sold := GREATEST(0, v_entry_sold - line_item.total_quantity);
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
        RAISE EXCEPTION 'Selected size % is unavailable for product %.', v_size_token, line_item.product_id;
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
      WHERE "Product_ID" = line_item.product_id;
    ELSE
      v_total_stock := GREATEST(0, COALESCE(NULLIF(v_product_row->>'Stock', '')::INTEGER, 0));
      v_total_sold := GREATEST(0, COALESCE(NULLIF(v_product_row->>'Items_Sold', '')::INTEGER, 0));
      v_total_sold := GREATEST(0, v_total_sold - line_item.total_quantity);
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
      WHERE "Product_ID" = line_item.product_id;
    END IF;
  END LOOP;

  UPDATE stock_reservations
  SET status = 'released', released_at = COALESCE(released_at, NOW())
  WHERE order_id = NEW.id
    AND status IN ('active', 'confirmed');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_apply_order_cancel_stock_restore ON orders;
CREATE TRIGGER trg_apply_order_cancel_stock_restore
AFTER UPDATE OF status ON orders
FOR EACH ROW
EXECUTE FUNCTION apply_order_cancel_stock_restore();

COMMIT;
