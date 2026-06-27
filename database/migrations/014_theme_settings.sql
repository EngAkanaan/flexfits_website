-- Edit Theme system: announcement bar, hero banner slideshow, homepage section settings.
-- Mirrors the existing project security model (no Supabase-Auth admin role exists yet;
-- the admin panel runs entirely client-side with the anon key, same as products/orders),
-- so RLS here is permissive like the other tables. If real Supabase Auth roles are added
-- later, tighten the INSERT/UPDATE/DELETE policies below to an authenticated/admin role.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==================== ANNOUNCEMENTS ====================

CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  text TEXT NOT NULL,
  link_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_announcements_active_sort ON announcements(is_active, sort_order);

ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Announcements are viewable by everyone" ON announcements;
DROP POLICY IF EXISTS "Announcements are insertable by everyone" ON announcements;
DROP POLICY IF EXISTS "Announcements are updatable by everyone" ON announcements;
DROP POLICY IF EXISTS "Announcements are deletable by everyone" ON announcements;

CREATE POLICY "Announcements are viewable by everyone" ON announcements FOR SELECT USING (true);
CREATE POLICY "Announcements are insertable by everyone" ON announcements FOR INSERT WITH CHECK (true);
CREATE POLICY "Announcements are updatable by everyone" ON announcements FOR UPDATE USING (true);
CREATE POLICY "Announcements are deletable by everyone" ON announcements FOR DELETE USING (true);

DROP TRIGGER IF EXISTS update_announcements_updated_at ON announcements;
CREATE TRIGGER update_announcements_updated_at
  BEFORE UPDATE ON announcements
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ==================== HERO SLIDES ====================

CREATE TABLE IF NOT EXISTS hero_slides (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT,
  subtitle TEXT,
  desktop_image_url TEXT NOT NULL,
  mobile_image_url TEXT,
  button_text TEXT,
  button_link TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hero_slides_active_sort ON hero_slides(is_active, sort_order);

ALTER TABLE hero_slides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Hero slides are viewable by everyone" ON hero_slides;
DROP POLICY IF EXISTS "Hero slides are insertable by everyone" ON hero_slides;
DROP POLICY IF EXISTS "Hero slides are updatable by everyone" ON hero_slides;
DROP POLICY IF EXISTS "Hero slides are deletable by everyone" ON hero_slides;

CREATE POLICY "Hero slides are viewable by everyone" ON hero_slides FOR SELECT USING (true);
CREATE POLICY "Hero slides are insertable by everyone" ON hero_slides FOR INSERT WITH CHECK (true);
CREATE POLICY "Hero slides are updatable by everyone" ON hero_slides FOR UPDATE USING (true);
CREATE POLICY "Hero slides are deletable by everyone" ON hero_slides FOR DELETE USING (true);

DROP TRIGGER IF EXISTS update_hero_slides_updated_at ON hero_slides;
CREATE TRIGGER update_hero_slides_updated_at
  BEFORE UPDATE ON hero_slides
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ==================== HOMEPAGE SECTION SETTINGS ====================

CREATE TABLE IF NOT EXISTS homepage_section_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  section_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  subtitle TEXT,
  is_visible BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_homepage_section_settings_visible_sort ON homepage_section_settings(is_visible, sort_order);

ALTER TABLE homepage_section_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Homepage sections are viewable by everyone" ON homepage_section_settings;
DROP POLICY IF EXISTS "Homepage sections are insertable by everyone" ON homepage_section_settings;
DROP POLICY IF EXISTS "Homepage sections are updatable by everyone" ON homepage_section_settings;
DROP POLICY IF EXISTS "Homepage sections are deletable by everyone" ON homepage_section_settings;

CREATE POLICY "Homepage sections are viewable by everyone" ON homepage_section_settings FOR SELECT USING (true);
CREATE POLICY "Homepage sections are insertable by everyone" ON homepage_section_settings FOR INSERT WITH CHECK (true);
CREATE POLICY "Homepage sections are updatable by everyone" ON homepage_section_settings FOR UPDATE USING (true);
CREATE POLICY "Homepage sections are deletable by everyone" ON homepage_section_settings FOR DELETE USING (true);

DROP TRIGGER IF EXISTS update_homepage_section_settings_updated_at ON homepage_section_settings;
CREATE TRIGGER update_homepage_section_settings_updated_at
  BEFORE UPDATE ON homepage_section_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

INSERT INTO homepage_section_settings (section_key, title, subtitle, is_visible, sort_order)
VALUES
  ('featured_products', 'Featured Products', 'Hand-picked gear from the current catalog', true, 0),
  ('new_arrivals', 'New Arrivals', 'The latest additions to Flex Fits', true, 1),
  ('best_sellers', 'Best Sellers', 'Customer favorites', true, 2),
  ('sale_collection', 'Sale Collection', 'Limited-time discounted gear', true, 3),
  ('brand_highlights', 'Brand Highlights', 'Shop by your favorite brand', false, 4)
ON CONFLICT (section_key) DO NOTHING;
