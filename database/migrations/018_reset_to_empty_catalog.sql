-- One-time reset: wipe all test/fake data so data entry can start from zero.
-- Run this in the Supabase SQL Editor once, then re-seed manually via the admin panel.
--
-- What this clears:
--   - All products, and everything that hangs off a product (stock reservations,
--     financial metrics, tag assignments, order items, orders).
--   - Test announcements and hero slides.
--   - Custom/tag-linked homepage sections (the 5 built-in sections are reset back
--     to their defaults so Edit Theme -> Homepage Sections still works afterwards --
--     there's no "create featured_products section" button, only "create from tag",
--     so leaving that table empty would permanently break those toggles).
--
-- What this does NOT touch:
--   - Tag definitions in the `tags` table (e.g. "Hoodies") -- only their assignments
--     to products are cleared, since products themselves are being deleted anyway.
--   - Your admin login (Supabase Auth user).
--   - Table structure, RLS policies, functions/triggers.
--
-- This does NOT delete files sitting in Storage buckets (product-images, theme-images).
-- Do that separately in the dashboard: Storage -> product-images -> select all -> Delete,
-- and the same for theme-images -- this is the only way that's guaranteed to actually
-- remove the underlying files, not just metadata rows.

BEGIN;

DELETE FROM order_items;
DELETE FROM orders;
DELETE FROM stock_reservations;
DELETE FROM product_financial_metrics;
DELETE FROM financial_dashboard_totals;
DELETE FROM product_tags;
DELETE FROM products;

DELETE FROM announcements;
DELETE FROM hero_slides;

DELETE FROM homepage_section_settings;
INSERT INTO homepage_section_settings (section_key, title, subtitle, is_visible, sort_order)
VALUES
  ('featured_products', 'Featured Products', 'Hand-picked gear from the current catalog', true, 0),
  ('new_arrivals', 'New Arrivals', 'The latest additions to Flex Fits', true, 1),
  ('best_sellers', 'Best Sellers', 'Customer favorites', true, 2),
  ('sale_collection', 'Sale Collection', 'Limited-time discounted gear', true, 3),
  ('brand_highlights', 'Brand Highlights', 'Shop by your favorite brand', false, 4)
ON CONFLICT (section_key) DO NOTHING;

COMMIT;
