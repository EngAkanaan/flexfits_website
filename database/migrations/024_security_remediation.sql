-- FlexFits final security remediation.
-- Apply after 023_secure_cleanup_failed_checkout_order.sql.
--
-- This migration is idempotent and non-destructive. It preserves the admin UUID used by
-- migration 016 as the initial membership row so the existing administrator is not locked out.
-- Add additional administrators explicitly after deployment:
--   INSERT INTO public.admin_users (user_id)
--   VALUES ('AUTH-USER-UUID-HERE'::uuid)
--   ON CONFLICT (user_id) DO NOTHING;

BEGIN;

-- ==================== DB-BACKED ADMIN MEMBERSHIP ====================

CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

-- Preserve whichever UUID is embedded in the existing migration-016 is_admin() definition,
-- without carrying that identity forward in the replacement function or this migration.
DO $$
DECLARE
  v_function_source TEXT;
  v_uuid_match TEXT[];
  v_admin_id UUID;
BEGIN
  SELECT pg_get_functiondef(to_regprocedure('public.is_admin()'))
  INTO v_function_source;

  v_uuid_match := regexp_match(
    COALESCE(v_function_source, ''),
    '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})'
  );

  IF v_uuid_match IS NOT NULL THEN
    v_admin_id := v_uuid_match[1]::UUID;
    INSERT INTO public.admin_users (user_id)
    SELECT id FROM auth.users WHERE id = v_admin_id
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_users
    WHERE user_id = auth.uid()
  );
$$;

REVOKE ALL ON TABLE public.admin_users FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.admin_users TO authenticated;

DROP POLICY IF EXISTS "Admin users can view own membership" ON public.admin_users;
CREATE POLICY "Admin users can view own membership"
  ON public.admin_users
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;

-- ==================== CHECKOUT-SAFE HELPERS ====================

-- A guest may attach an order item only when it exactly matches one of that order's live
-- reservations. This closes the old "any item on any guessed pending order" policy gap.
CREATE OR REPLACE FUNCTION public.order_accepts_item(
  p_order_id TEXT,
  p_reservation_id UUID,
  p_product_id TEXT,
  p_size TEXT,
  p_quantity INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.orders o
    JOIN public.stock_reservations r
      ON r.id = p_reservation_id
     AND r.session_id = o.reservation_session_id
    WHERE o.id = p_order_id
      AND LOWER(COALESCE(o.status, '')) = 'pending'
      AND COALESCE(o.reservation_session_id, '') <> ''
      AND r.status = 'active'
      AND r.expires_at > NOW()
      AND r.product_id = p_product_id
      AND UPPER(TRIM(COALESCE(r.size, ''))) = UPPER(TRIM(COALESCE(p_size, '')))
      AND r.quantity = p_quantity
  );
$$;

-- Storefront availability needs only totals, never reservation IDs or session tokens.
CREATE OR REPLACE FUNCTION public.get_active_stock_reservation_totals()
RETURNS TABLE(product_id TEXT, size TEXT, quantity BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT r.product_id, r.size, SUM(r.quantity)::BIGINT
  FROM public.stock_reservations r
  WHERE r.status = 'active'
    AND r.expires_at > NOW()
  GROUP BY r.product_id, r.size;
$$;

-- A shopper can recover only reservations protected by their own high-entropy session token.
CREATE OR REPLACE FUNCTION public.get_session_active_reservations(p_session_id TEXT)
RETURNS TABLE(
  id UUID,
  product_id TEXT,
  size TEXT,
  quantity INTEGER,
  session_id TEXT,
  status TEXT,
  reserved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  order_id TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    r.id,
    r.product_id,
    r.size,
    r.quantity,
    r.session_id,
    r.status,
    r.reserved_at,
    r.expires_at,
    r.order_id
  FROM public.stock_reservations r
  WHERE LENGTH(COALESCE(TRIM(p_session_id), '')) >= 32
    AND r.session_id = p_session_id
    AND r.status = 'active'
    AND r.expires_at > NOW();
$$;

REVOKE ALL ON FUNCTION public.order_accepts_item(TEXT, UUID, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_active_stock_reservation_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_session_active_reservations(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.order_accepts_item(TEXT, UUID, TEXT, TEXT, INTEGER) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_stock_reservation_totals() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_session_active_reservations(TEXT) TO anon, authenticated;

-- The legacy financial refresh is SECURITY DEFINER but did not check admin membership.
-- Keep its calculation body intact under an internal name and expose a guarded wrapper.
-- Product-maintenance triggers must retain access because checkout stock commits update products;
-- only a direct RPC call (trigger depth zero) requires an authenticated admin.
DO $$
BEGIN
  IF to_regprocedure('public.refresh_product_financial_metrics_internal()') IS NULL THEN
    EXECUTE 'ALTER FUNCTION public.refresh_product_financial_metrics() RENAME TO refresh_product_financial_metrics_internal';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.refresh_product_financial_metrics()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF pg_trigger_depth() = 0 AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin authorization required.';
  END IF;

  PERFORM public.refresh_product_financial_metrics_internal();
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_product_financial_metrics_internal() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_product_financial_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_product_financial_metrics() TO authenticated;

-- ==================== RLS POLICY NORMALIZATION ====================

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_financial_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_dashboard_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hero_slides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.homepage_section_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_settings ENABLE ROW LEVEL SECURITY;

-- Products
DROP POLICY IF EXISTS "Products are viewable by everyone" ON public.products;
DROP POLICY IF EXISTS "Products are insertable by everyone" ON public.products;
DROP POLICY IF EXISTS "Products are updatable by everyone" ON public.products;
DROP POLICY IF EXISTS "Products are deletable by everyone" ON public.products;
DROP POLICY IF EXISTS "Products are insertable by admin" ON public.products;
DROP POLICY IF EXISTS "Products are updatable by admin" ON public.products;
DROP POLICY IF EXISTS "Products are deletable by admin" ON public.products;
CREATE POLICY "Products are viewable by everyone" ON public.products FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Products are insertable by admin" ON public.products FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Products are updatable by admin" ON public.products FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Products are deletable by admin" ON public.products FOR DELETE TO authenticated USING (public.is_admin());

-- Orders
DROP POLICY IF EXISTS "Orders are viewable by everyone" ON public.orders;
DROP POLICY IF EXISTS "Orders are insertable by everyone" ON public.orders;
DROP POLICY IF EXISTS "Orders are updatable by everyone" ON public.orders;
DROP POLICY IF EXISTS "Orders are deletable by everyone" ON public.orders;
DROP POLICY IF EXISTS "Orders are viewable by admin" ON public.orders;
DROP POLICY IF EXISTS "Orders are insertable by guests as pending" ON public.orders;
DROP POLICY IF EXISTS "Orders are updatable by admin" ON public.orders;
DROP POLICY IF EXISTS "Orders are deletable by admin" ON public.orders;
CREATE POLICY "Orders are viewable by admin" ON public.orders FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Orders are insertable by guests as pending" ON public.orders
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    LOWER(COALESCE(status, '')) = 'pending'
    AND total >= 0
    AND LENGTH(COALESCE(TRIM(reservation_session_id), '')) >= 32
  );
CREATE POLICY "Orders are updatable by admin" ON public.orders FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Orders are deletable by admin" ON public.orders FOR DELETE TO authenticated USING (public.is_admin());

-- Order items
DROP POLICY IF EXISTS "Order items are viewable by everyone" ON public.order_items;
DROP POLICY IF EXISTS "Order items are insertable by everyone" ON public.order_items;
DROP POLICY IF EXISTS "Order items are deletable by everyone" ON public.order_items;
DROP POLICY IF EXISTS "Order items are viewable by admin" ON public.order_items;
DROP POLICY IF EXISTS "Order items are insertable for pending orders" ON public.order_items;
DROP POLICY IF EXISTS "Order items match checkout reservation" ON public.order_items;
DROP POLICY IF EXISTS "Order items are deletable by admin" ON public.order_items;
CREATE POLICY "Order items are viewable by admin" ON public.order_items FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Order items match checkout reservation" ON public.order_items
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    quantity > 0
    AND price >= 0
    AND reservation_id IS NOT NULL
    AND public.order_accepts_item(order_id, reservation_id, product_id, size, quantity)
  );
CREATE POLICY "Order items are deletable by admin" ON public.order_items FOR DELETE TO authenticated USING (public.is_admin());

-- Reservation rows contain bearer-like session tokens: never expose the table publicly.
DROP POLICY IF EXISTS "Stock reservations are viewable by everyone" ON public.stock_reservations;
DROP POLICY IF EXISTS "Stock reservations are insertable by everyone" ON public.stock_reservations;
DROP POLICY IF EXISTS "Stock reservations are updatable by everyone" ON public.stock_reservations;
DROP POLICY IF EXISTS "Stock reservations are deletable by everyone" ON public.stock_reservations;
DROP POLICY IF EXISTS "Stock reservations are insertable by admin" ON public.stock_reservations;
DROP POLICY IF EXISTS "Stock reservations are updatable by admin" ON public.stock_reservations;
DROP POLICY IF EXISTS "Stock reservations are deletable by admin" ON public.stock_reservations;
DROP POLICY IF EXISTS "Stock reservations are viewable by admin" ON public.stock_reservations;
CREATE POLICY "Stock reservations are viewable by admin" ON public.stock_reservations FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Stock reservations are insertable by admin" ON public.stock_reservations FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Stock reservations are updatable by admin" ON public.stock_reservations FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Stock reservations are deletable by admin" ON public.stock_reservations FOR DELETE TO authenticated USING (public.is_admin());

-- Admin-only financial data
DROP POLICY IF EXISTS "Financial metrics are viewable by everyone" ON public.product_financial_metrics;
DROP POLICY IF EXISTS "Financial metrics are insertable by everyone" ON public.product_financial_metrics;
DROP POLICY IF EXISTS "Financial metrics are updatable by everyone" ON public.product_financial_metrics;
DROP POLICY IF EXISTS "Financial metrics are viewable by admin" ON public.product_financial_metrics;
DROP POLICY IF EXISTS "Financial metrics are insertable by admin" ON public.product_financial_metrics;
DROP POLICY IF EXISTS "Financial metrics are updatable by admin" ON public.product_financial_metrics;
DROP POLICY IF EXISTS "Financial metrics are deletable by admin" ON public.product_financial_metrics;
CREATE POLICY "Financial metrics are viewable by admin" ON public.product_financial_metrics FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Financial metrics are insertable by admin" ON public.product_financial_metrics FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Financial metrics are updatable by admin" ON public.product_financial_metrics FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Financial metrics are deletable by admin" ON public.product_financial_metrics FOR DELETE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Financial totals are viewable by everyone" ON public.financial_dashboard_totals;
DROP POLICY IF EXISTS "Financial totals are insertable by everyone" ON public.financial_dashboard_totals;
DROP POLICY IF EXISTS "Financial totals are updatable by everyone" ON public.financial_dashboard_totals;
DROP POLICY IF EXISTS "Financial totals are viewable by admin" ON public.financial_dashboard_totals;
DROP POLICY IF EXISTS "Financial totals are insertable by admin" ON public.financial_dashboard_totals;
DROP POLICY IF EXISTS "Financial totals are updatable by admin" ON public.financial_dashboard_totals;
DROP POLICY IF EXISTS "Financial totals are deletable by admin" ON public.financial_dashboard_totals;
CREATE POLICY "Financial totals are viewable by admin" ON public.financial_dashboard_totals FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Financial totals are insertable by admin" ON public.financial_dashboard_totals FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Financial totals are updatable by admin" ON public.financial_dashboard_totals FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Financial totals are deletable by admin" ON public.financial_dashboard_totals FOR DELETE TO authenticated USING (public.is_admin());

-- Theme, tags, and settings: public reads; DB-backed admin writes.
DROP POLICY IF EXISTS "Announcements are viewable by everyone" ON public.announcements;
DROP POLICY IF EXISTS "Announcements are insertable by everyone" ON public.announcements;
DROP POLICY IF EXISTS "Announcements are updatable by everyone" ON public.announcements;
DROP POLICY IF EXISTS "Announcements are deletable by everyone" ON public.announcements;
DROP POLICY IF EXISTS "Announcements are viewable by active or admin" ON public.announcements;
DROP POLICY IF EXISTS "Announcements are insertable by admin" ON public.announcements;
DROP POLICY IF EXISTS "Announcements are updatable by admin" ON public.announcements;
DROP POLICY IF EXISTS "Announcements are deletable by admin" ON public.announcements;
CREATE POLICY "Announcements are viewable by active or admin" ON public.announcements FOR SELECT TO anon, authenticated USING (is_active OR public.is_admin());
CREATE POLICY "Announcements are insertable by admin" ON public.announcements FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Announcements are updatable by admin" ON public.announcements FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Announcements are deletable by admin" ON public.announcements FOR DELETE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Hero slides are viewable by everyone" ON public.hero_slides;
DROP POLICY IF EXISTS "Hero slides are insertable by everyone" ON public.hero_slides;
DROP POLICY IF EXISTS "Hero slides are updatable by everyone" ON public.hero_slides;
DROP POLICY IF EXISTS "Hero slides are deletable by everyone" ON public.hero_slides;
DROP POLICY IF EXISTS "Hero slides are viewable by active or admin" ON public.hero_slides;
DROP POLICY IF EXISTS "Hero slides are insertable by admin" ON public.hero_slides;
DROP POLICY IF EXISTS "Hero slides are updatable by admin" ON public.hero_slides;
DROP POLICY IF EXISTS "Hero slides are deletable by admin" ON public.hero_slides;
CREATE POLICY "Hero slides are viewable by active or admin" ON public.hero_slides FOR SELECT TO anon, authenticated USING (is_active OR public.is_admin());
CREATE POLICY "Hero slides are insertable by admin" ON public.hero_slides FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Hero slides are updatable by admin" ON public.hero_slides FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Hero slides are deletable by admin" ON public.hero_slides FOR DELETE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Homepage sections are viewable by everyone" ON public.homepage_section_settings;
DROP POLICY IF EXISTS "Homepage sections are insertable by everyone" ON public.homepage_section_settings;
DROP POLICY IF EXISTS "Homepage sections are updatable by everyone" ON public.homepage_section_settings;
DROP POLICY IF EXISTS "Homepage sections are deletable by everyone" ON public.homepage_section_settings;
DROP POLICY IF EXISTS "Homepage sections are viewable by visible or admin" ON public.homepage_section_settings;
DROP POLICY IF EXISTS "Homepage sections are insertable by admin" ON public.homepage_section_settings;
DROP POLICY IF EXISTS "Homepage sections are updatable by admin" ON public.homepage_section_settings;
DROP POLICY IF EXISTS "Homepage sections are deletable by admin" ON public.homepage_section_settings;
CREATE POLICY "Homepage sections are viewable by visible or admin" ON public.homepage_section_settings FOR SELECT TO anon, authenticated USING (is_visible OR public.is_admin());
CREATE POLICY "Homepage sections are insertable by admin" ON public.homepage_section_settings FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Homepage sections are updatable by admin" ON public.homepage_section_settings FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Homepage sections are deletable by admin" ON public.homepage_section_settings FOR DELETE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Tags are viewable by everyone" ON public.tags;
DROP POLICY IF EXISTS "Tags are insertable by admin" ON public.tags;
DROP POLICY IF EXISTS "Tags are updatable by admin" ON public.tags;
DROP POLICY IF EXISTS "Tags are deletable by admin" ON public.tags;
CREATE POLICY "Tags are viewable by everyone" ON public.tags FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Tags are insertable by admin" ON public.tags FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Tags are updatable by admin" ON public.tags FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Tags are deletable by admin" ON public.tags FOR DELETE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Product tags are viewable by everyone" ON public.product_tags;
DROP POLICY IF EXISTS "Product tags are insertable by admin" ON public.product_tags;
DROP POLICY IF EXISTS "Product tags are updatable by admin" ON public.product_tags;
DROP POLICY IF EXISTS "Product tags are deletable by admin" ON public.product_tags;
CREATE POLICY "Product tags are viewable by everyone" ON public.product_tags FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Product tags are insertable by admin" ON public.product_tags FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Product tags are updatable by admin" ON public.product_tags FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Product tags are deletable by admin" ON public.product_tags FOR DELETE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Store settings are viewable by everyone" ON public.store_settings;
DROP POLICY IF EXISTS "Store settings are insertable by admin" ON public.store_settings;
DROP POLICY IF EXISTS "Store settings are updatable by admin" ON public.store_settings;
CREATE POLICY "Store settings are viewable by everyone" ON public.store_settings FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Store settings are insertable by admin" ON public.store_settings FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Store settings are updatable by admin" ON public.store_settings FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ==================== EXPLICIT TABLE PRIVILEGES ====================

REVOKE ALL ON TABLE
  public.products,
  public.orders,
  public.order_items,
  public.stock_reservations,
  public.product_financial_metrics,
  public.financial_dashboard_totals,
  public.announcements,
  public.hero_slides,
  public.homepage_section_settings,
  public.tags,
  public.product_tags,
  public.store_settings
FROM anon, authenticated;

GRANT SELECT ON TABLE
  public.products,
  public.announcements,
  public.hero_slides,
  public.homepage_section_settings,
  public.tags,
  public.product_tags,
  public.store_settings
TO anon, authenticated;

GRANT INSERT ON TABLE public.orders, public.order_items TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.products,
  public.orders,
  public.order_items,
  public.stock_reservations,
  public.product_financial_metrics,
  public.financial_dashboard_totals,
  public.announcements,
  public.hero_slides,
  public.homepage_section_settings,
  public.tags,
  public.product_tags,
  public.store_settings
TO authenticated;

-- ==================== RPC EXECUTION PRIVILEGES ====================

REVOKE ALL ON FUNCTION public.reserve_product_stock_fcfs(TEXT, TEXT, TEXT, INTEGER, INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_stock_reservation(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.extend_stock_reservation(TEXT, UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_expired_stock_reservations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_checkout_reservations(TEXT, TEXT, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_failed_checkout_order(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_order_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.order_is_pending(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_remove_order_item(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_order_delivery_fee(TEXT, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_order_line_stock(TEXT, TEXT, INTEGER) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.reserve_product_stock_fcfs(TEXT, TEXT, TEXT, INTEGER, INTEGER, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_stock_reservation(TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extend_stock_reservation(TEXT, UUID, INTEGER) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_stock_reservations() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_checkout_reservations(TEXT, TEXT, UUID[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_failed_checkout_order(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_order_id() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_order_item(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_order_delivery_fee(TEXT, NUMERIC) TO authenticated;

-- ==================== STORAGE ====================

DROP POLICY IF EXISTS "product-images-public-read" ON storage.objects;
DROP POLICY IF EXISTS "product-images-anon-insert" ON storage.objects;
DROP POLICY IF EXISTS "product-images-auth-insert" ON storage.objects;
DROP POLICY IF EXISTS "product-images-auth-delete" ON storage.objects;
DROP POLICY IF EXISTS "product-images-admin-insert" ON storage.objects;
DROP POLICY IF EXISTS "product-images-admin-update" ON storage.objects;
DROP POLICY IF EXISTS "product-images-admin-delete" ON storage.objects;
CREATE POLICY "product-images-public-read" ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'product-images');
CREATE POLICY "product-images-admin-insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'product-images' AND public.is_admin());
CREATE POLICY "product-images-admin-update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'product-images' AND public.is_admin()) WITH CHECK (bucket_id = 'product-images' AND public.is_admin());
CREATE POLICY "product-images-admin-delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'product-images' AND public.is_admin());

DROP POLICY IF EXISTS "theme-images-public-read" ON storage.objects;
DROP POLICY IF EXISTS "theme-images-anon-insert" ON storage.objects;
DROP POLICY IF EXISTS "theme-images-auth-insert" ON storage.objects;
DROP POLICY IF EXISTS "theme-images-anon-delete" ON storage.objects;
DROP POLICY IF EXISTS "theme-images-auth-delete" ON storage.objects;
DROP POLICY IF EXISTS "theme-images-admin-insert" ON storage.objects;
DROP POLICY IF EXISTS "theme-images-admin-update" ON storage.objects;
DROP POLICY IF EXISTS "theme-images-admin-delete" ON storage.objects;
CREATE POLICY "theme-images-public-read" ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'theme-images');
CREATE POLICY "theme-images-admin-insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'theme-images' AND public.is_admin());
CREATE POLICY "theme-images-admin-update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'theme-images' AND public.is_admin()) WITH CHECK (bucket_id = 'theme-images' AND public.is_admin());
CREATE POLICY "theme-images-admin-delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'theme-images' AND public.is_admin());

COMMIT;
