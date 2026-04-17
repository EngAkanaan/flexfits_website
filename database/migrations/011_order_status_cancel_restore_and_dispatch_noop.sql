-- Make order dispatch status updates stock-neutral and restore stock when a pending order is canceled.

BEGIN;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending', 'dispatched', 'canceled', 'delivered', 'shipped', 'cancelled'));

CREATE OR REPLACE FUNCTION apply_order_dispatch_stock_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Stock is committed at checkout and restored on cancel.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_order_cancel_stock_restore()
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

    v_next_size_stock := NULL;
    v_size_token := UPPER(TRIM(COALESCE(line_item.size, '')));

    IF (v_product_row ? 'size_stock') AND jsonb_typeof(v_product_row->'size_stock') = 'array' THEN
      IF v_size_token = '' THEN
        RAISE EXCEPTION 'Selected size is required for product % during cancel.', line_item.product_id;
      END IF;

      SELECT COALESCE((entry->>'left')::INTEGER, 0)
      INTO v_size_left
      FROM jsonb_array_elements(v_product_row->'size_stock') AS entry
      WHERE UPPER(TRIM(COALESCE(entry->>'size', ''))) = v_size_token
      LIMIT 1;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Selected size % is unavailable for product %.', v_size_token, line_item.product_id;
      END IF;

      SELECT COALESCE(
        jsonb_agg(
          CASE
            WHEN UPPER(TRIM(COALESCE(entry->>'size', ''))) = v_size_token THEN
              jsonb_set(
                jsonb_set(entry, '{left}', to_jsonb(GREATEST(0, COALESCE((entry->>'left')::INTEGER, 0) + line_item.total_quantity))),
                '{sold}',
                to_jsonb(GREATEST(0, COALESCE((entry->>'sold')::INTEGER, 0) - line_item.total_quantity))
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
        "Items_Sold" = COALESCE(v_calc_total_sold, 0),
        "Status" = CASE WHEN COALESCE(v_calc_total_left, 0) <= 0 THEN 'Temporarily unavailable' ELSE 'In Stock' END,
        size_stock = v_next_size_stock
      WHERE "Product_ID" = line_item.product_id;
    ELSE
      UPDATE products
      SET
        "Items_Sold" = GREATEST(0, COALESCE("Items_Sold", 0) - line_item.total_quantity),
        "Status" = CASE
          WHEN GREATEST(0, COALESCE("Stock", 0) - GREATEST(0, COALESCE("Items_Sold", 0) - line_item.total_quantity)) <= 0
            THEN 'Temporarily unavailable'
          ELSE 'In Stock'
        END
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

CREATE OR REPLACE FUNCTION refresh_product_financial_metrics()
RETURNS TABLE (
  product_id TEXT,
  product_name TEXT,
  items_sold INTEGER,
  item_price NUMERIC,
  item_cost NUMERIC,
  revenue NUMERIC,
  net_profit NUMERIC,
  calculated_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  WITH order_history AS (
    SELECT
      oi.product_id::TEXT AS product_id,
      MAX(COALESCE(NULLIF(oi.product_name, ''), oi.product_id::TEXT))::TEXT AS name_of_product,
      SUM(GREATEST(0, COALESCE(oi.quantity, 0)))::INTEGER AS items_sold,
      SUM(GREATEST(0, COALESCE(oi.quantity, 0)) * GREATEST(0, COALESCE(oi.price, 0)))::NUMERIC AS revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE COALESCE(LOWER(o.status), 'pending') IN ('dispatched', 'shipped', 'delivered')
    GROUP BY oi.product_id
  ),
  product_costs AS (
    SELECT
      COALESCE(NULLIF("Product_ID", ''), NULLIF(id, ''))::TEXT AS product_id,
      COALESCE("Cost", 0)::NUMERIC AS item_cost
    FROM products
  )
  SELECT
    h.product_id,
    h.name_of_product,
    h.items_sold,
    CASE WHEN h.items_sold > 0 THEN h.revenue / h.items_sold ELSE 0 END,
    COALESCE(pc.item_cost, 0),
    h.revenue,
    h.revenue - (COALESCE(pc.item_cost, 0) * h.items_sold),
    NOW()
  FROM order_history h
  LEFT JOIN product_costs pc ON pc.product_id = h.product_id
  WHERE h.product_id IS NOT NULL AND h.product_id <> '';
END;
$$ LANGUAGE plpgsql;

COMMIT;
