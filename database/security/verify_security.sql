-- Read-only post-deployment verification for 024_security_remediation.sql.
-- Expected: no rows from the "problems" queries and at least one admin membership.

-- Application tables that exist without RLS.
SELECT n.nspname AS schema_name, c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname = 'public'
  AND c.relname IN (
    'admin_users', 'products', 'orders', 'order_items', 'stock_reservations',
    'product_financial_metrics', 'financial_dashboard_totals', 'announcements',
    'hero_slides', 'homepage_section_settings', 'tags', 'product_tags', 'store_settings'
  )
  AND NOT c.relrowsecurity
ORDER BY 1, 2;

-- Complete application policy inventory.
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname IN ('public', 'storage')
ORDER BY schemaname, tablename, policyname;

-- Public write policies that are not the two deliberately narrow checkout inserts.
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  AND (roles && ARRAY['anon'::name, 'public'::name])
  AND NOT (tablename IN ('orders', 'order_items') AND cmd = 'INSERT')
ORDER BY tablename, policyname;

-- Unrestricted writes. Expected: zero rows.
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname IN ('public', 'storage')
  AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  AND (
    COALESCE(TRIM(qual), '') IN ('true', '(true)')
    OR COALESCE(TRIM(with_check), '') IN ('true', '(true)')
  )
ORDER BY schemaname, tablename, policyname;

-- Storage policy inventory. Writes should be authenticated + public.is_admin().
SELECT policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
  AND (
    COALESCE(qual, '') LIKE '%product-images%'
    OR COALESCE(with_check, '') LIKE '%product-images%'
    OR COALESCE(qual, '') LIKE '%theme-images%'
    OR COALESCE(with_check, '') LIKE '%theme-images%'
  )
ORDER BY policyname;

-- Security-definer functions and their fixed search_path configuration.
SELECT
  n.nspname AS schema_name,
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  p.prosecdef AS security_definer,
  p.proconfig
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'is_admin', 'order_accepts_item', 'get_active_stock_reservation_totals',
    'get_session_active_reservations', 'reserve_product_stock_fcfs',
    'release_stock_reservation', 'extend_stock_reservation',
    'cleanup_expired_stock_reservations', 'commit_checkout_reservations',
    'cleanup_failed_checkout_order', 'generate_order_id',
    'admin_remove_order_item', 'admin_set_order_delivery_fee',
    'refresh_product_financial_metrics', 'refresh_product_financial_metrics_internal'
  )
ORDER BY p.proname, arguments;

-- Direct table privileges granted to browser roles.
SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee IN ('anon', 'authenticated')
  AND table_schema IN ('public', 'storage')
ORDER BY grantee, table_schema, table_name, privilege_type;

-- Function execution grants to browser roles.
SELECT grantee, routine_schema, routine_name, privilege_type
FROM information_schema.role_routine_grants
WHERE grantee IN ('PUBLIC', 'anon', 'authenticated')
  AND routine_schema = 'public'
ORDER BY routine_name, grantee;

-- Must be at least 1 before relying on admin UI access.
SELECT COUNT(*) AS configured_admin_count FROM public.admin_users;

-- Must return false when executed without a signed-in admin JWT.
SELECT public.is_admin() AS current_session_is_admin;
