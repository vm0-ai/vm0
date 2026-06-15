-- Epic #10577 Phase 2: flip all storages.type = 'memory' rows to 'artifact'.
-- Dual-read compat in turbo/apps/web/src/lib/infra/storage/storage-service.ts
-- (added in #10600) keeps manifest resolution correct through the flip.
-- The "memory" zod enum value and ensureStorageExists(..., "memory") branch
-- are intentionally left in place; removed in #10603.

-- Pre-flight guard: abort if any (org_id, user_id, name) has both a
-- type='memory' and type='artifact' row — the flip would violate
-- idx_storages_org_user_name_type. Prod scan confirmed zero collisions,
-- but this guard protects against new writes between scan and deploy.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM storages m
    WHERE type = 'memory'
      AND EXISTS (
        SELECT 1 FROM storages a
        WHERE a.type = 'artifact'
          AND a.org_id = m.org_id
          AND a.user_id = m.user_id
          AND a.name = m.name
      )
  ) THEN
    RAISE EXCEPTION 'storages has memory/artifact name collisions — resolve before flipping';
  END IF;
END $$;--> statement-breakpoint
UPDATE storages SET type = 'artifact' WHERE type = 'memory';
