-- Create and secure storage bucket for product image uploads.
BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  true,
  52428800,
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
      AND policyname = 'product-images-public-read'
  ) THEN
    CREATE POLICY "product-images-public-read"
      ON storage.objects
      FOR SELECT
      USING (bucket_id = 'product-images');
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
      AND policyname = 'product-images-anon-insert'
  ) THEN
    CREATE POLICY "product-images-anon-insert"
      ON storage.objects
      FOR INSERT
      WITH CHECK (bucket_id = 'product-images' AND auth.role() = 'anon');
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
      AND policyname = 'product-images-auth-insert'
  ) THEN
    CREATE POLICY "product-images-auth-insert"
      ON storage.objects
      FOR INSERT
      WITH CHECK (bucket_id = 'product-images' AND auth.role() = 'authenticated');
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
      AND policyname = 'product-images-auth-delete'
  ) THEN
    CREATE POLICY "product-images-auth-delete"
      ON storage.objects
      FOR DELETE
      USING (bucket_id = 'product-images' AND auth.role() = 'authenticated');
  END IF;
END
$$;

COMMIT;
