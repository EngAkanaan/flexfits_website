ALTER TABLE products
  ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS size_stock JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS original_price DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS on_sale BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  -- Newer schema variant
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'image'
  ) THEN
    EXECUTE $sql$
      UPDATE products
      SET images = ARRAY[image]
      WHERE (images IS NULL OR array_length(images, 1) IS NULL)
        AND COALESCE(image, '') <> ''
    $sql$;
  -- Legacy CSV-style schema variant used in this project
  ELSIF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'Pictures'
  ) THEN
    EXECUTE $sql$
      UPDATE products
      SET images = ARRAY["Pictures"]
      WHERE (images IS NULL OR array_length(images, 1) IS NULL)
        AND COALESCE("Pictures", '') <> ''
    $sql$;
  END IF;
END
$$;

UPDATE products
SET on_sale = COALESCE(on_sale, FALSE)
WHERE on_sale IS NULL;
