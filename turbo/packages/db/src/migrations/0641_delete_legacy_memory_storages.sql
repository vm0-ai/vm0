-- Remove the ten type='memory' storages created during the rolling deployment
-- after migration 0298 flipped the then-existing rows to type='artifact'. The
-- legacy writer was removed later in that rollout, but no final sweep ran.
--
-- The guards intentionally abort if any legacy writer or reader has touched
-- this state since it was verified for issue #21983. Deleting the storages
-- cascades to their storage_versions and storage_version_lineage rows. R2
-- objects are retained because legacy and active storages can share a prefix.
DO $$
DECLARE
  target_ids uuid[] := ARRAY[
    'c0ba5859-3f04-4e73-86af-f2ecfda38920',
    '40bcddf8-dded-4bd3-ba01-889aab237e2c',
    'a3cd07d8-ed1d-41eb-ad86-36eee81f439b',
    'bb526398-1475-44a1-bfe8-31de6492aa68',
    '09b476e2-a966-4c48-b04b-8c7ab525d427',
    '834c8df9-4755-4252-b0dd-4b1f96f257e6',
    '1ccfe6e9-f780-46f0-8174-f29b04808d08',
    '6ed6253f-6a87-4f62-95dd-6cf54eb019cc',
    '8612fe6d-ea43-4e13-8b37-40a77d9949d6',
    'cfea61f2-e97f-4726-8806-505454a4d175'
  ]::uuid[];
  row_count integer;
BEGIN
  SELECT count(*) INTO row_count
  FROM storages
  WHERE type = 'memory';

  -- Fresh databases never received writes from the retired memory writer.
  IF row_count = 0 THEN
    RETURN;
  END IF;

  IF row_count <> 10 THEN
    RAISE EXCEPTION 'expected exactly 10 legacy memory storages, found %', row_count;
  END IF;

  SELECT count(*) INTO row_count
  FROM storages
  WHERE id = ANY(target_ids)
    AND type = 'memory';

  IF row_count <> 10 THEN
    RAISE EXCEPTION 'legacy memory storage IDs no longer match the verified set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM storages
    WHERE id = ANY(target_ids)
      AND updated_at > timestamp '2026-04-22 22:56:22.312'
  ) THEN
    RAISE EXCEPTION 'a legacy memory storage was updated after verification';
  END IF;

  SELECT count(*) INTO row_count
  FROM storage_versions
  WHERE storage_id = ANY(target_ids);

  IF row_count <> 14 THEN
    RAISE EXCEPTION 'expected 14 legacy memory storage versions, found %', row_count;
  END IF;

  SELECT count(*) INTO row_count
  FROM storage_version_lineage
  WHERE storage_id = ANY(target_ids);

  IF row_count <> 4 THEN
    RAISE EXCEPTION 'expected 4 legacy memory lineage rows, found %', row_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM skills
    WHERE storage_id = ANY(target_ids)
  ) THEN
    RAISE EXCEPTION 'a skill still references a legacy memory storage';
  END IF;

  DELETE FROM storages
  WHERE id = ANY(target_ids)
    AND type = 'memory';

  GET DIAGNOSTICS row_count = ROW_COUNT;

  IF row_count <> 10 THEN
    RAISE EXCEPTION 'expected to delete 10 legacy memory storages, deleted %', row_count;
  END IF;
END $$;
