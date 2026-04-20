-- Add type column to storages table
ALTER TABLE "storages" ADD COLUMN "type" varchar(16) NOT NULL DEFAULT 'volume';
