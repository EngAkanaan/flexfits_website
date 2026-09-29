-- Emergency rollback for 024_security_remediation.sql.
--
-- WARNING: this intentionally restores weaker behavior for compatibility. In particular,
-- any authenticated user becomes an admin and reservation metadata becomes publicly readable.
-- Use only to recover service, disable public sign-ups first, and reapply migration 024 quickly.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT auth.role() = 'authenticated';
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;

DROP POLICY IF EXISTS "Order items match checkout reservation" ON public.order_items;
CREATE POLICY "Order items are insertable for pending orders"
  ON public.order_items
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (public.order_is_pending(order_id));

DROP POLICY IF EXISTS "Stock reservations are viewable by admin" ON public.stock_reservations;
CREATE POLICY "Stock reservations are viewable by everyone"
  ON public.stock_reservations
  FOR SELECT
  TO anon, authenticated
  USING (true);

GRANT SELECT ON TABLE public.stock_reservations TO anon, authenticated;

DROP POLICY IF EXISTS "product-images-admin-insert" ON storage.objects;
DROP POLICY IF EXISTS "product-images-admin-update" ON storage.objects;
DROP POLICY IF EXISTS "product-images-admin-delete" ON storage.objects;
CREATE POLICY "product-images-auth-insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'product-images');
CREATE POLICY "product-images-auth-delete" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'product-images');

DROP POLICY IF EXISTS "theme-images-admin-insert" ON storage.objects;
DROP POLICY IF EXISTS "theme-images-admin-update" ON storage.objects;
DROP POLICY IF EXISTS "theme-images-admin-delete" ON storage.objects;
CREATE POLICY "theme-images-auth-insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'theme-images');
CREATE POLICY "theme-images-auth-delete" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'theme-images');

COMMIT;

-- The admin_users table and narrow RPCs are intentionally retained: dropping them would destroy
-- membership data and is unnecessary for compatibility. Reapplying 024 restores the secure
-- policies and DB-backed is_admin() implementation.
