-- Security hardening: real admin auth + locked-down RLS.
--
-- BEFORE RUNNING THIS FILE:
--   1. Supabase dashboard -> Authentication -> Settings -> turn OFF "Allow new users to sign up".
--   2. Supabase dashboard -> Authentication -> Users -> Add User -> create your one admin
--      account (real email + strong password). Click into it and copy the "User UID".
--   3. Replace the placeholder UUID below (in is_admin()) with that UID.
--   4. Deploy the app code changes that ship alongside this migration FIRST, and confirm you
--      can log into /admin with the new email/password BEFORE running this file -- at that
--      point RLS is still the old permissive policies, so nothing breaks either way yet.
--   5. Only then run this file in the SQL Editor.
--
-- After running: re-test guest checkout (logged out / incognito) AND every admin action
-- (dispatch/cancel/destroy order, product CRUD, Edit Theme CRUD + image upload).

-- ==================== ADMIN IDENTITY ====================

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  -- TODO: replace with your admin user's UID from Authentication -> Users in the Supabase dashboard.
  SELECT auth.uid() = 'b9d1a514-a1af-4253-8bd3-073c4012f38d'::uuid;
$$;

-- ==================== PRODUCTS ====================

DROP POLICY IF EXISTS "Products are viewable by everyone" ON products;
DROP POLICY IF EXISTS "Products are insertable by everyone" ON products;
DROP POLICY IF EXISTS "Products are updatable by everyone" ON products;
DROP POLICY IF EXISTS "Products are deletable by everyone" ON products;

CREATE POLICY "Products are viewable by everyone" ON products FOR SELECT USING (true);
CREATE POLICY "Products are insertable by admin" ON products FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Products are updatable by admin" ON products FOR UPDATE USING (is_admin());
CREATE POLICY "Products are deletable by admin" ON products FOR DELETE USING (is_admin());

-- ==================== ORDERS / ORDER ITEMS ====================
-- Guest checkout has no login, so order/order_item creation must stay public -- but scoped so a
-- direct API call can't insert anything except a fresh pending order with items attached to it.

DROP POLICY IF EXISTS "Orders are viewable by everyone" ON orders;
DROP POLICY IF EXISTS "Orders are insertable by everyone" ON orders;
DROP POLICY IF EXISTS "Orders are updatable by everyone" ON orders;
DROP POLICY IF EXISTS "Orders are deletable by everyone" ON orders;

CREATE POLICY "Orders are viewable by admin" ON orders FOR SELECT USING (is_admin());
CREATE POLICY "Orders are insertable by guests as pending" ON orders FOR INSERT WITH CHECK (status = 'pending');
CREATE POLICY "Orders are updatable by admin" ON orders FOR UPDATE USING (is_admin());
CREATE POLICY "Orders are deletable by admin" ON orders FOR DELETE USING (is_admin());

DROP POLICY IF EXISTS "Order items are viewable by everyone" ON order_items;
DROP POLICY IF EXISTS "Order items are insertable by everyone" ON order_items;
DROP POLICY IF EXISTS "Order items are deletable by everyone" ON order_items;

CREATE POLICY "Order items are viewable by admin" ON order_items FOR SELECT USING (is_admin());
CREATE POLICY "Order items are insertable for pending orders" ON order_items FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND o.status = 'pending')
);
CREATE POLICY "Order items are deletable by admin" ON order_items FOR DELETE USING (is_admin());

-- ==================== STOCK RESERVATIONS ====================
-- SELECT stays public: getProducts() reads this table to compute live stock availability for
-- everyone browsing the site. Writes are admin-only at the table level -- guest cart/checkout
-- flows never write here directly, they exclusively call the RPCs below, which are converted to
-- SECURITY DEFINER so they keep working for anon regardless of this table-level lock-down.

DROP POLICY IF EXISTS "Stock reservations are viewable by everyone" ON stock_reservations;
DROP POLICY IF EXISTS "Stock reservations are insertable by everyone" ON stock_reservations;
DROP POLICY IF EXISTS "Stock reservations are updatable by everyone" ON stock_reservations;
DROP POLICY IF EXISTS "Stock reservations are deletable by everyone" ON stock_reservations;

CREATE POLICY "Stock reservations are viewable by everyone" ON stock_reservations FOR SELECT USING (true);
CREATE POLICY "Stock reservations are insertable by admin" ON stock_reservations FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Stock reservations are updatable by admin" ON stock_reservations FOR UPDATE USING (is_admin());
CREATE POLICY "Stock reservations are deletable by admin" ON stock_reservations FOR DELETE USING (is_admin());

-- ==================== FINANCIAL METRICS ====================
-- Revenue/profit numbers are not customer-facing data; lock down read and write entirely.

DROP POLICY IF EXISTS "Financial metrics are viewable by everyone" ON product_financial_metrics;
DROP POLICY IF EXISTS "Financial metrics are insertable by everyone" ON product_financial_metrics;
DROP POLICY IF EXISTS "Financial metrics are updatable by everyone" ON product_financial_metrics;
DROP POLICY IF EXISTS "Financial totals are viewable by everyone" ON financial_dashboard_totals;
DROP POLICY IF EXISTS "Financial totals are insertable by everyone" ON financial_dashboard_totals;
DROP POLICY IF EXISTS "Financial totals are updatable by everyone" ON financial_dashboard_totals;

CREATE POLICY "Financial metrics are viewable by admin" ON product_financial_metrics FOR SELECT USING (is_admin());
CREATE POLICY "Financial metrics are insertable by admin" ON product_financial_metrics FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Financial metrics are updatable by admin" ON product_financial_metrics FOR UPDATE USING (is_admin());

CREATE POLICY "Financial totals are viewable by admin" ON financial_dashboard_totals FOR SELECT USING (is_admin());
CREATE POLICY "Financial totals are insertable by admin" ON financial_dashboard_totals FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Financial totals are updatable by admin" ON financial_dashboard_totals FOR UPDATE USING (is_admin());

-- ==================== EDIT THEME TABLES ====================
-- Public may only read active/visible rows; admin can read and write everything.

DROP POLICY IF EXISTS "Announcements are viewable by everyone" ON announcements;
DROP POLICY IF EXISTS "Announcements are insertable by everyone" ON announcements;
DROP POLICY IF EXISTS "Announcements are updatable by everyone" ON announcements;
DROP POLICY IF EXISTS "Announcements are deletable by everyone" ON announcements;

CREATE POLICY "Announcements are viewable by active or admin" ON announcements FOR SELECT USING (is_active = true OR is_admin());
CREATE POLICY "Announcements are insertable by admin" ON announcements FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Announcements are updatable by admin" ON announcements FOR UPDATE USING (is_admin());
CREATE POLICY "Announcements are deletable by admin" ON announcements FOR DELETE USING (is_admin());

DROP POLICY IF EXISTS "Hero slides are viewable by everyone" ON hero_slides;
DROP POLICY IF EXISTS "Hero slides are insertable by everyone" ON hero_slides;
DROP POLICY IF EXISTS "Hero slides are updatable by everyone" ON hero_slides;
DROP POLICY IF EXISTS "Hero slides are deletable by everyone" ON hero_slides;

CREATE POLICY "Hero slides are viewable by active or admin" ON hero_slides FOR SELECT USING (is_active = true OR is_admin());
CREATE POLICY "Hero slides are insertable by admin" ON hero_slides FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Hero slides are updatable by admin" ON hero_slides FOR UPDATE USING (is_admin());
CREATE POLICY "Hero slides are deletable by admin" ON hero_slides FOR DELETE USING (is_admin());

DROP POLICY IF EXISTS "Homepage sections are viewable by everyone" ON homepage_section_settings;
DROP POLICY IF EXISTS "Homepage sections are insertable by everyone" ON homepage_section_settings;
DROP POLICY IF EXISTS "Homepage sections are updatable by everyone" ON homepage_section_settings;
DROP POLICY IF EXISTS "Homepage sections are deletable by everyone" ON homepage_section_settings;

CREATE POLICY "Homepage sections are viewable by visible or admin" ON homepage_section_settings FOR SELECT USING (is_visible = true OR is_admin());
CREATE POLICY "Homepage sections are insertable by admin" ON homepage_section_settings FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Homepage sections are updatable by admin" ON homepage_section_settings FOR UPDATE USING (is_admin());
CREATE POLICY "Homepage sections are deletable by admin" ON homepage_section_settings FOR DELETE USING (is_admin());

-- ==================== RESERVATION / CHECKOUT RPCs -> SECURITY DEFINER ====================
-- Guest/anon callers keep working (they only ever call these RPCs, never write the tables
-- directly), even though the tables above now deny anon direct writes.

ALTER FUNCTION reserve_product_stock_fcfs(text, text, text, integer, integer, uuid) SECURITY DEFINER SET search_path = public, extensions;
ALTER FUNCTION release_stock_reservation(text, uuid) SECURITY DEFINER SET search_path = public, extensions;
ALTER FUNCTION extend_stock_reservation(text, uuid, integer) SECURITY DEFINER SET search_path = public, extensions;
ALTER FUNCTION cleanup_expired_stock_reservations() SECURITY DEFINER SET search_path = public, extensions;
ALTER FUNCTION commit_checkout_reservations(text, text, uuid[]) SECURITY DEFINER SET search_path = public, extensions;

-- ==================== CHECKOUT FAILURE CLEANUP RPC ====================
-- saveOrder() inserts the order row, then commits reservations; if the reservation commit fails,
-- it needs to delete the now-orphaned pending order. Orders DELETE is admin-only above, so this
-- narrow, validated RPC (only ever deletes a still-pending order by its own id) covers that case
-- for anon without reopening direct DELETE access.

CREATE OR REPLACE FUNCTION cleanup_failed_checkout_order(p_order_id TEXT)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public, extensions
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM orders WHERE id = p_order_id AND status = 'pending';
  RETURN FOUND;
END;
$$;

-- ==================== STORAGE: PRODUCT / THEME IMAGES ====================
-- Remove anon upload/delete; admin uploads now happen under an authenticated session.

DROP POLICY IF EXISTS "product-images-anon-insert" ON storage.objects;
DROP POLICY IF EXISTS "theme-images-anon-insert" ON storage.objects;
DROP POLICY IF EXISTS "theme-images-anon-delete" ON storage.objects;
