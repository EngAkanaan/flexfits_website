-- MIGRATION: Switch products table to use Product_ID as primary key and update all references

BEGIN;

-- 1. Add Product_ID as primary key if not already present
ALTER TABLE products ADD COLUMN IF NOT EXISTS "Product_ID" TEXT;

-- 2. Backfill Product_ID for any rows missing it (if not already done)
UPDATE products SET "Product_ID" = 'FF-' || nextval('product_id_seq') WHERE COALESCE("Product_ID", '') = '';

-- Drop the unique constraint if it already exists, then add it
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'products_product_id_key'
	) THEN
		ALTER TABLE products DROP CONSTRAINT products_product_id_key;
	END IF;
END$$;
ALTER TABLE products ADD CONSTRAINT products_product_id_key UNIQUE ("Product_ID");
ALTER TABLE products ALTER COLUMN "Product_ID" SET NOT NULL;

-- 4. Drop foreign key constraint on order_items before dropping products primary key
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_product_id_fkey;


-- 6. Drop products primary key, then re-add it on Product_ID
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pkey;
ALTER TABLE products ADD CONSTRAINT products_pkey PRIMARY KEY ("Product_ID");

-- 7. Re-add the foreign key on order_items to reference products(Product_ID)
ALTER TABLE order_items ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products("Product_ID") ON DELETE RESTRICT;


-- 8. Optionally drop the old id column if not needed
-- ALTER TABLE products DROP COLUMN IF EXISTS id;

COMMIT;

-- NOTE: If you have other tables referencing products(id), update them similarly.
-- Always backup your data before running destructive migrations!