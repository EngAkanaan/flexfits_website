-- MIGRATION: Make items_left_in_stock a generated column

BEGIN;

-- Remove items_left_in_stock if it exists (will re-add as generated)
ALTER TABLE products DROP COLUMN IF EXISTS items_left_in_stock;

-- Add items_left_in_stock as a generated column
ALTER TABLE products ADD COLUMN items_left_in_stock integer GENERATED ALWAYS AS (stock - items_sold) STORED;

COMMIT;
