-- FlexFits: ensure `products.colors` is a PostgreSQL text[] for array filters (.contains / .overlaps).
-- Run in Supabase SQL Editor. Safe to run multiple times.

ALTER TABLE products ADD COLUMN IF NOT EXISTS colors TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN products.colors IS 'Color tags per product, e.g. {black,white}; use lowercase in app.';
