-- Flex Fits Database Schema for Supabase
-- Run this SQL in Supabase SQL Editor after clearing existing tables

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Products Table
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT 'Unisex' CHECK (gender IN ('Men', 'Women', 'Unisex')),
  category TEXT NOT NULL CHECK (category IN ('Shoes', 'Tshirts', 'Socks', 'Hoodies')),
  type TEXT NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  cost DECIMAL(10, 2) NOT NULL,
  initial_stock INTEGER NOT NULL DEFAULT 0,
  pieces INTEGER NOT NULL DEFAULT 0,
  sold INTEGER NOT NULL DEFAULT 0,
  sizes TEXT[] NOT NULL DEFAULT '{}',
  description TEXT NOT NULL,
  image TEXT NOT NULL,
  is_authentic BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Orders Table
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  governorate TEXT NOT NULL,
  district TEXT NOT NULL,
  village TEXT NOT NULL,
  address_details TEXT NOT NULL,
  total DECIMAL(10, 2) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'shipped', 'delivered', 'cancelled')) DEFAULT 'pending',
  date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Order Items Table (for storing items in each order)
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  size TEXT NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_pieces ON products(pieces);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_date ON orders(date DESC);
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);

-- Create a function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers to auto-update updated_at
CREATE TRIGGER update_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (RLS)
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

-- Create policies for public read access (products are public)
CREATE POLICY "Products are viewable by everyone"
  ON products FOR SELECT
  USING (true);

-- Create policies for authenticated users (for admin operations)
-- Note: You'll need to set up authentication if you want admin-only access
-- For now, we'll allow public inserts/updates (you can restrict this later)
CREATE POLICY "Products are insertable by everyone"
  ON products FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Products are updatable by everyone"
  ON products FOR UPDATE
  USING (true);

CREATE POLICY "Products are deletable by everyone"
  ON products FOR DELETE
  USING (true);

-- Orders policies
CREATE POLICY "Orders are viewable by everyone"
  ON orders FOR SELECT
  USING (true);

CREATE POLICY "Orders are insertable by everyone"
  ON orders FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Orders are updatable by everyone"
  ON orders FOR UPDATE
  USING (true);

CREATE POLICY "Orders are deletable by everyone"
  ON orders FOR DELETE
  USING (true);

-- Order items policies
CREATE POLICY "Order items are viewable by everyone"
  ON order_items FOR SELECT
  USING (true);

CREATE POLICY "Order items are insertable by everyone"
  ON order_items FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Order items are deletable by everyone"
  ON order_items FOR DELETE
  USING (true);

-- ==================== STOCK AUTOMATION ====================
-- Run this section when using the CSV-style products table with these columns:
-- Product_ID, SIZE, Stock, Items_Sold, Items_LEFT_in_stock
-- Inventory updates ONLY when admin dispatches/approves an order (pending -> shipped).

CREATE OR REPLACE FUNCTION apply_order_dispatch_stock_change()
RETURNS TRIGGER AS $$
DECLARE
  line_item RECORD;
  current_left INTEGER;
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

    UPDATE products
    SET
      "Items_Sold" = COALESCE("Items_Sold", 0) + line_item.total_quantity,
      "Items_LEFT_in_stock" = GREATEST(0, COALESCE("Items_LEFT_in_stock", 0) - line_item.total_quantity),
      "Status" = CASE
        WHEN GREATEST(0, COALESCE("Items_LEFT_in_stock", 0) - line_item.total_quantity) = 0 THEN 'Temporarily unavailable'
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

DROP TRIGGER IF EXISTS trg_apply_order_item_stock_change ON order_items;
DROP TRIGGER IF EXISTS trg_apply_order_dispatch_stock_change ON orders;
CREATE TRIGGER trg_apply_order_dispatch_stock_change
AFTER UPDATE OF status ON orders
FOR EACH ROW
EXECUTE FUNCTION apply_order_dispatch_stock_change();

-- ==================== PRODUCT ID / NAME MIGRATION ====================
-- 1) Keep Product_ID as primary product key
-- 2) Keep Name_of_Brand and add Name_of_Product
-- 3) Auto-generate Product_ID values as FF-101 ... FF-9999

ALTER TABLE products ADD COLUMN IF NOT EXISTS "Product_ID" TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS "Name_of_Product" TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS "Gender" TEXT;

-- Backfill and constrain product gender values for existing rows.
UPDATE products
SET "Gender" = 'Unisex'
WHERE COALESCE(TRIM("Gender"), '') = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'products_gender_check'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_gender_check CHECK ("Gender" IN ('Men', 'Women', 'Unisex'));
  END IF;
END
$$;

-- If Name_of_Product is empty, backfill from existing product name.
UPDATE products
SET "Name_of_Product" = COALESCE("Name_of_Product", name)
WHERE COALESCE("Name_of_Product", '') = '';

CREATE SEQUENCE IF NOT EXISTS product_id_seq START WITH 101 INCREMENT BY 1 MINVALUE 101 MAXVALUE 9999;

-- Ensure sequence continues after current max Product_ID if values already exist.
SELECT setval(
  'product_id_seq',
  GREATEST(
    101,
    COALESCE((SELECT MAX(CAST(REGEXP_REPLACE("Product_ID", '^FF-', '') AS INTEGER)) + 1 FROM products WHERE "Product_ID" ~ '^FF-[0-9]+$'), 101)
  ),
  false
);

-- Assign Product_ID to rows that don't have one.
UPDATE products
SET "Product_ID" = 'FF-' || nextval('product_id_seq')
WHERE COALESCE("Product_ID", '') = '';

-- Enforce uniqueness for upsert conflict target.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'products_product_id_key'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_product_id_key UNIQUE ("Product_ID");
  END IF;
END
$$;

-- ==================== FINANCIAL METRICS TABLE ====================
-- Stores computed per-product totals from current products table values:
-- revenue = Items_Sold * Price
-- net_profit = revenue - (Cost * Items_Sold)

CREATE TABLE IF NOT EXISTS product_financial_metrics (
  product_id TEXT PRIMARY KEY,
  name_of_product TEXT NOT NULL,
  items_sold INTEGER NOT NULL DEFAULT 0,
  item_price DECIMAL(10, 2) NOT NULL DEFAULT 0,
  item_cost DECIMAL(10, 2) NOT NULL DEFAULT 0,
  item_revenue DECIMAL(12, 2) NOT NULL DEFAULT 0,
  net_profit DECIMAL(12, 2) NOT NULL DEFAULT 0,
  calculated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_financial_metrics_profit ON product_financial_metrics(net_profit DESC);

CREATE TABLE IF NOT EXISTS financial_dashboard_totals (
  id TEXT PRIMARY KEY,
  total_revenue DECIMAL(14, 2) NOT NULL DEFAULT 0,
  total_net_profit DECIMAL(14, 2) NOT NULL DEFAULT 0,
  calculated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE product_financial_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_dashboard_totals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Financial metrics are viewable by everyone" ON product_financial_metrics;
DROP POLICY IF EXISTS "Financial metrics are insertable by everyone" ON product_financial_metrics;
DROP POLICY IF EXISTS "Financial metrics are updatable by everyone" ON product_financial_metrics;
DROP POLICY IF EXISTS "Financial totals are viewable by everyone" ON financial_dashboard_totals;
DROP POLICY IF EXISTS "Financial totals are insertable by everyone" ON financial_dashboard_totals;
DROP POLICY IF EXISTS "Financial totals are updatable by everyone" ON financial_dashboard_totals;

CREATE POLICY "Financial metrics are viewable by everyone"
  ON product_financial_metrics FOR SELECT
  USING (true);

CREATE POLICY "Financial metrics are insertable by everyone"
  ON product_financial_metrics FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Financial metrics are updatable by everyone"
  ON product_financial_metrics FOR UPDATE
  USING (true);

CREATE POLICY "Financial totals are viewable by everyone"
  ON financial_dashboard_totals FOR SELECT
  USING (true);

CREATE POLICY "Financial totals are insertable by everyone"
  ON financial_dashboard_totals FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Financial totals are updatable by everyone"
  ON financial_dashboard_totals FOR UPDATE
  USING (true);

-- Recalculate all item-level financial rows from historical orders and order_items.
-- revenue = items_sold * item_price
-- net_profit = revenue - (item_cost * items_sold)
CREATE OR REPLACE FUNCTION refresh_product_financial_metrics()
RETURNS VOID AS $$
BEGIN
  INSERT INTO product_financial_metrics (
    product_id,
    name_of_product,
    items_sold,
    item_price,
    item_cost,
    item_revenue,
    net_profit,
    calculated_at
  )
  WITH order_history AS (
    SELECT
      oi.product_id::TEXT AS product_id,
      MAX(COALESCE(NULLIF(oi.product_name, ''), oi.product_id::TEXT))::TEXT AS name_of_product,
      SUM(GREATEST(0, COALESCE(oi.quantity, 0)))::INTEGER AS items_sold,
      SUM(GREATEST(0, COALESCE(oi.quantity, 0)) * GREATEST(0, COALESCE(oi.price, 0)))::DECIMAL(12, 2) AS item_revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE COALESCE(LOWER(o.status), 'pending') IN ('shipped', 'delivered')
    GROUP BY oi.product_id
  ),
  product_costs AS (
    SELECT
      COALESCE(
        to_jsonb(p)->>'Product_ID',
        to_jsonb(p)->>'id'
      )::TEXT AS product_id,
      GREATEST(0, COALESCE(NULLIF(to_jsonb(p)->>'Cost', '')::NUMERIC, NULLIF(to_jsonb(p)->>'cost', '')::NUMERIC, 0))::DECIMAL(10, 2) AS item_cost
    FROM products p
  )
  SELECT
    h.product_id,
    h.name_of_product,
    h.items_sold,
    CASE WHEN h.items_sold > 0 THEN (h.item_revenue / h.items_sold)::DECIMAL(10, 2) ELSE 0 END AS item_price,
    COALESCE(pc.item_cost, 0)::DECIMAL(10, 2) AS item_cost,
    h.item_revenue,
    (h.item_revenue - (COALESCE(pc.item_cost, 0) * h.items_sold))::DECIMAL(12, 2) AS net_profit,
    NOW() AS calculated_at
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

  INSERT INTO financial_dashboard_totals (
    id,
    total_revenue,
    total_net_profit,
    calculated_at
  )
  SELECT
    'global',
    COALESCE(SUM(item_revenue), 0)::DECIMAL(14, 2),
    COALESCE(SUM(net_profit), 0)::DECIMAL(14, 2),
    NOW()
  FROM product_financial_metrics
  ON CONFLICT (id) DO UPDATE SET
    total_revenue = EXCLUDED.total_revenue,
    total_net_profit = EXCLUDED.total_net_profit,
    calculated_at = EXCLUDED.calculated_at;
END;
$$ LANGUAGE plpgsql;

-- Keep metrics current whenever products are inserted/updated.
CREATE OR REPLACE FUNCTION trg_refresh_product_financial_metrics()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM refresh_product_financial_metrics();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_refresh_financial_metrics ON products;
CREATE TRIGGER trg_products_refresh_financial_metrics
AFTER INSERT OR UPDATE ON products
FOR EACH STATEMENT
EXECUTE FUNCTION trg_refresh_product_financial_metrics();

-- One-time backfill for all currently sold items.
SELECT refresh_product_financial_metrics();

-- ==================== FCFS STOCK RESERVATIONS ====================
-- First-come, first-served temporary stock holds.
-- Availability = current product stock - active (non-expired) reservations.

CREATE TABLE IF NOT EXISTS stock_reservations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id TEXT NOT NULL,
  size TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'released')),
  reserved_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  confirmed_at TIMESTAMP WITH TIME ZONE,
  released_at TIMESTAMP WITH TIME ZONE,
  order_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_reservations_product ON stock_reservations(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_product_active ON stock_reservations(product_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_session_active ON stock_reservations(session_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_expires ON stock_reservations(expires_at);

ALTER TABLE stock_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Stock reservations are viewable by everyone" ON stock_reservations;
DROP POLICY IF EXISTS "Stock reservations are insertable by everyone" ON stock_reservations;
DROP POLICY IF EXISTS "Stock reservations are updatable by everyone" ON stock_reservations;
DROP POLICY IF EXISTS "Stock reservations are deletable by everyone" ON stock_reservations;

CREATE POLICY "Stock reservations are viewable by everyone"
  ON stock_reservations FOR SELECT
  USING (true);

CREATE POLICY "Stock reservations are insertable by everyone"
  ON stock_reservations FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Stock reservations are updatable by everyone"
  ON stock_reservations FOR UPDATE
  USING (true);

CREATE POLICY "Stock reservations are deletable by everyone"
  ON stock_reservations FOR DELETE
  USING (true);

DROP TRIGGER IF EXISTS update_stock_reservations_updated_at ON stock_reservations;
CREATE TRIGGER update_stock_reservations_updated_at
  BEFORE UPDATE ON stock_reservations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

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
  v_ctid TID;
  v_total_stock INTEGER;
  v_existing_qty INTEGER := 0;
  v_reserved_others INTEGER := 0;
  v_target_qty INTEGER;
  v_now TIMESTAMP WITH TIME ZONE := NOW();
  v_exp TIMESTAMP WITH TIME ZONE;
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

  -- Mark expired active rows as released before availability math.
  UPDATE stock_reservations sr
  SET status = 'released', released_at = COALESCE(sr.released_at, v_now)
  WHERE sr.status = 'active' AND sr.expires_at <= v_now;

  SELECT p.ctid, to_jsonb(p)
  INTO v_ctid, v_row
  FROM products p
  WHERE COALESCE(NULLIF(to_jsonb(p)->>'Product_ID', ''), NULLIF(to_jsonb(p)->>'id', '')) = p_product_id
  LIMIT 1
  FOR UPDATE;

  IF v_row IS NULL THEN
    RETURN QUERY SELECT false, 'Product not found.', NULL::UUID, NULL::TIMESTAMPTZ, 0;
    RETURN;
  END IF;

  v_total_stock := GREATEST(
    0,
    COALESCE(
      NULLIF(v_row->>'Items_LEFT_in_stock', '')::INTEGER,
      NULLIF(v_row->>'pieces', '')::INTEGER,
      NULLIF(v_row->>'Stock', '')::INTEGER,
      0
    )
  );

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

  SELECT COALESCE(SUM(quantity), 0)
  INTO v_reserved_others
  FROM stock_reservations sr
  WHERE sr.product_id = p_product_id
    AND sr.status = 'active'
    AND sr.expires_at > v_now
    AND (p_existing_reservation_id IS NULL OR sr.id <> p_existing_reservation_id);

  v_target_qty := CASE WHEN p_existing_reservation_id IS NULL THEN p_quantity ELSE v_existing_qty + p_quantity END;

  IF v_total_stock - v_reserved_others < v_target_qty THEN
    RETURN QUERY SELECT false, 'Reserved by another shopper. Please reduce quantity.', NULL::UUID, NULL::TIMESTAMPTZ, GREATEST(0, v_total_stock - v_reserved_others);
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
      RETURN QUERY SELECT false, 'Existing reservation is no longer valid.', NULL::UUID, NULL::TIMESTAMPTZ, GREATEST(0, v_total_stock - v_reserved_others);
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  SELECT true, 'Reserved successfully.', v_reservation_id, v_exp, GREATEST(0, v_total_stock - v_reserved_others - v_target_qty);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION release_stock_reservation(
  p_session_id TEXT,
  p_reservation_id UUID
)
RETURNS BOOLEAN AS $$
DECLARE
  v_now TIMESTAMP WITH TIME ZONE := NOW();
BEGIN
  UPDATE stock_reservations
  SET status = 'released', released_at = COALESCE(released_at, v_now)
  WHERE id = p_reservation_id
    AND session_id = p_session_id
    AND status = 'active';

  RETURN FOUND;
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
  SET expires_at = v_new_exp
  WHERE sr.id = p_reservation_id
    AND sr.session_id = p_session_id
    AND sr.status = 'active'
    AND sr.expires_at <= v_now
    AND sr.expires_at >= v_now - INTERVAL '120 seconds';

  IF FOUND THEN
    RETURN QUERY SELECT true, 'Reservation extended.', v_new_exp;
  ELSE
    RETURN QUERY SELECT false, 'Reservation cannot be extended.', NULL::TIMESTAMPTZ;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cleanup_expired_stock_reservations()
RETURNS INTEGER AS $$
DECLARE
  v_now TIMESTAMP WITH TIME ZONE := NOW();
  v_count INTEGER;
BEGIN
  UPDATE stock_reservations sr
  SET status = 'released', released_at = COALESCE(sr.released_at, v_now)
  WHERE sr.status = 'active' AND sr.expires_at <= v_now;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN COALESCE(v_count, 0);
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
  v_left INTEGER;
  v_sold INTEGER;
  v_next_left INTEGER;
  v_next_sold INTEGER;
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

    v_left := GREATEST(0, COALESCE(NULLIF(v_row->>'Items_LEFT_in_stock', '')::INTEGER, NULLIF(v_row->>'pieces', '')::INTEGER, NULLIF(v_row->>'Stock', '')::INTEGER, 0));
    v_sold := GREATEST(0, COALESCE(NULLIF(v_row->>'Items_Sold', '')::INTEGER, NULLIF(v_row->>'sold', '')::INTEGER, 0));

    IF v_left < v_res.quantity THEN
      RETURN QUERY SELECT false, 'Some items in your cart have expired.', v_committed;
      RETURN;
    END IF;

    v_next_left := GREATEST(0, v_left - v_res.quantity);
    v_next_sold := GREATEST(0, v_sold + v_res.quantity);

    v_set_clause := '';
    IF v_row ? 'Items_LEFT_in_stock' THEN
      v_set_clause := v_set_clause || CASE WHEN v_set_clause = '' THEN '' ELSE ', ' END || '"Items_LEFT_in_stock" = ' || v_next_left;
    END IF;
    IF v_row ? 'pieces' THEN
      v_set_clause := v_set_clause || CASE WHEN v_set_clause = '' THEN '' ELSE ', ' END || 'pieces = ' || v_next_left;
    END IF;
    IF v_row ? 'Stock' THEN
      v_set_clause := v_set_clause || CASE WHEN v_set_clause = '' THEN '' ELSE ', ' END || '"Stock" = ' || v_next_left;
    END IF;
    IF v_row ? 'Items_Sold' THEN
      v_set_clause := v_set_clause || CASE WHEN v_set_clause = '' THEN '' ELSE ', ' END || '"Items_Sold" = ' || v_next_sold;
    END IF;
    IF v_row ? 'sold' THEN
      v_set_clause := v_set_clause || CASE WHEN v_set_clause = '' THEN '' ELSE ', ' END || 'sold = ' || v_next_sold;
    END IF;
    IF v_row ? 'Status' THEN
      v_set_clause := v_set_clause || CASE WHEN v_set_clause = '' THEN '' ELSE ', ' END || '"Status" = ' || quote_literal(CASE WHEN v_next_left = 0 THEN 'Temporarily unavailable' ELSE 'In Stock' END);
    END IF;
    IF v_row ? 'status' THEN
      v_set_clause := v_set_clause || CASE WHEN v_set_clause = '' THEN '' ELSE ', ' END || 'status = ' || quote_literal(CASE WHEN v_next_left = 0 THEN 'Temporarily unavailable' ELSE 'In Stock' END);
    END IF;

    IF COALESCE(v_set_clause, '') = '' THEN
      RETURN QUERY SELECT false, 'Product stock columns are missing.', v_committed;
      RETURN;
    END IF;

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

-- Optional scheduler for reservation cleanup (every minute).
-- This block is safe on projects where pg_cron is unavailable.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;

  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'cleanup-expired-stock-reservations';

  PERFORM cron.schedule(
    'cleanup-expired-stock-reservations',
    '* * * * *',
    'SELECT cleanup_expired_stock_reservations();'
  );
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron setup skipped: %', SQLERRM;
END;
$$;

