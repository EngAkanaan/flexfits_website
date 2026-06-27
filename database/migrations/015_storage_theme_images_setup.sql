-- Create and secure storage bucket for Edit Theme image uploads (hero banner desktop/mobile images).
-- Mirrors 008_storage_product_images_setup.sql.
BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'theme-images',
  'theme-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'theme-images-public-read'
  ) THEN
    CREATE POLICY "theme-images-public-read"
      ON storage.objects
      FOR SELECT
      USING (bucket_id = 'theme-images');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'theme-images-anon-insert'
  ) THEN
    CREATE POLICY "theme-images-anon-insert"
      ON storage.objects
      FOR INSERT
      WITH CHECK (bucket_id = 'theme-images' AND auth.role() = 'anon');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'theme-images-auth-insert'
  ) THEN
    CREATE POLICY "theme-images-auth-insert"
      ON storage.objects
      FOR INSERT
      WITH CHECK (bucket_id = 'theme-images' AND auth.role() = 'authenticated');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'theme-images-anon-delete'
  ) THEN
    CREATE POLICY "theme-images-anon-delete"
      ON storage.objects
      FOR DELETE
      USING (bucket_id = 'theme-images' AND auth.role() = 'anon');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'theme-images-auth-delete'
  ) THEN
    CREATE POLICY "theme-images-auth-delete"
      ON storage.objects
      FOR DELETE
      USING (bucket_id = 'theme-images' AND auth.role() = 'authenticated');
  END IF;
END
$$;

COMMIT;
