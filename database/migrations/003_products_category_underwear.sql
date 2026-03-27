-- App uses Category.UNDERWEAR = 'Underwear'. Older CHECK constraints only listed Hoodies/Tshirts.
-- Run in Supabase SQL Editor if upserts fail with category check violations.

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_check;

ALTER TABLE products
  ADD CONSTRAINT products_category_check
  CHECK (category IN ('Shoes', 'Socks', 'Underwear', 'Tshirts', 'Hoodies'));
