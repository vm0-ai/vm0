-- Rename volume sentinel userId from __scope__ to __org__
UPDATE "storages" SET "user_id" = '__org__' WHERE "user_id" = '__scope__' AND "type" = 'volume';
