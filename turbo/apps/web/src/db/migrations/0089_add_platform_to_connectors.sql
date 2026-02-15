-- Migration: Add platform and Nango connection ID to connectors
-- This migration adds support for both self-hosted and Nango-managed OAuth connectors

ALTER TABLE "connectors" ADD COLUMN "platform" varchar(50) DEFAULT 'self-hosted' NOT NULL;
ALTER TABLE "connectors" ADD COLUMN "nango_connection_id" varchar(255);
CREATE INDEX "idx_connectors_platform" ON "connectors" USING btree ("platform");
