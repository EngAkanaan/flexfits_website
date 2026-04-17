-- Backfill Stock/Items_Sold from size_stock so total stock reflects all variants.
-- This fixes drift where Stock may only reflect a single size while size_stock contains correct totals.

BEGIN;

WITH size_stock_totals AS (
  SELECT
    p."Product_ID" AS product_id,
    COALESCE(
      SUM(
        GREATEST(
          0,
          COALESCE((entry->>'stock')::INTEGER, 0),
          COALESCE((entry->>'left')::INTEGER, 0) + COALESCE((entry->>'sold')::INTEGER, 0)
        )
      ),
      0
    )::INTEGER AS total_stock,
    COALESCE(SUM(GREATEST(0, COALESCE((entry->>'left')::INTEGER, 0))), 0)::INTEGER AS total_left,
    COALESCE(SUM(GREATEST(0, COALESCE((entry->>'sold')::INTEGER, 0))), 0)::INTEGER AS total_sold
  FROM products p
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(p.size_stock) = 'array' THEN p.size_stock
      ELSE '[]'::JSONB
    END
  ) AS entry
  GROUP BY p."Product_ID"
)
UPDATE products p
SET
  "Stock" = t.total_stock,
  "Items_Sold" = LEAST(t.total_stock, t.total_sold),
  "Status" = CASE
    WHEN t.total_left <= 0 THEN 'Temporarily unavailable'
    ELSE 'In Stock'
  END
FROM size_stock_totals t
WHERE p."Product_ID" = t.product_id;

COMMIT;
