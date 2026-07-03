WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY installation_id, vm0_user_id
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS row_number
  FROM telegram_user_links
)
DELETE FROM telegram_user_links
WHERE id IN (
  SELECT id
  FROM ranked
  WHERE row_number > 1
);
