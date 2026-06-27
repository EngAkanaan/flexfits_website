-- Tags system: group products by tag, and let "Edit Theme" -> "Homepage Sections" display all
-- products carrying a given tag (Shopify-collection-style), in addition to the existing
-- featured/new/best-sellers/sale/brand-highlight sections.
--
-- Security note: if you already ran 016_security_hardening_rls.sql, `is_admin()` exists and
-- checks your specific admin UUID -- this migration reuses it as-is and never redefines it. If
-- you haven't run 016 yet, this migration creates a basic fallback `is_admin()` (any
-- authenticated user) so these two new tables are still admin-only; running 016 later replaces
-- the fallback with the UUID-specific check automatically (CREATE OR REPLACE in 016 takes over).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_admin') THEN
    CREATE FUNCTION is_admin()
    RETURNS BOOLEAN
    LANGUAGE sql
    STABLE
    AS $f$
      SELECT auth.role() = 'authenticated';
    $f$;
  END IF;
END
$$;

-- ==================== TAGS ====================

CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_unique ON tags (LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_slug_unique ON tags (slug);

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tags are viewable by everyone" ON tags;
DROP POLICY IF EXISTS "Tags are insertable by admin" ON tags;
DROP POLICY IF EXISTS "Tags are updatable by admin" ON tags;
DROP POLICY IF EXISTS "Tags are deletable by admin" ON tags;

CREATE POLICY "Tags are viewable by everyone" ON tags FOR SELECT USING (true);
CREATE POLICY "Tags are insertable by admin" ON tags FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Tags are updatable by admin" ON tags FOR UPDATE USING (is_admin());
CREATE POLICY "Tags are deletable by admin" ON tags FOR DELETE USING (is_admin());

-- ==================== PRODUCT <-> TAG (many-to-many) ====================

CREATE TABLE IF NOT EXISTS product_tags (
  product_id TEXT NOT NULL REFERENCES products("Product_ID") ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_product_tags_tag_id ON product_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_product_tags_product_id ON product_tags(product_id);

ALTER TABLE product_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Product tags are viewable by everyone" ON product_tags;
DROP POLICY IF EXISTS "Product tags are insertable by admin" ON product_tags;
DROP POLICY IF EXISTS "Product tags are updatable by admin" ON product_tags;
DROP POLICY IF EXISTS "Product tags are deletable by admin" ON product_tags;

CREATE POLICY "Product tags are viewable by everyone" ON product_tags FOR SELECT USING (true);
CREATE POLICY "Product tags are insertable by admin" ON product_tags FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Product tags are updatable by admin" ON product_tags FOR UPDATE USING (is_admin());
CREATE POLICY "Product tags are deletable by admin" ON product_tags FOR DELETE USING (is_admin());

-- ==================== HOMEPAGE SECTIONS: LINK TO A TAG ====================

ALTER TABLE homepage_section_settings ADD COLUMN IF NOT EXISTS tag_id UUID REFERENCES tags(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_homepage_section_settings_tag_id ON homepage_section_settings(tag_id);
