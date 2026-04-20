-- Migration: Add blobs table for content-addressable storage
-- Generated: 2025-11-30T04:30:00Z
-- This enables file-level deduplication across storage versions

CREATE TABLE IF NOT EXISTS "blobs" (
  "hash" varchar(64) PRIMARY KEY,
  "size" bigint NOT NULL,
  "ref_count" integer NOT NULL DEFAULT 1,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Index for garbage collection queries (finding blobs with ref_count = 0)
CREATE INDEX IF NOT EXISTS "idx_blobs_ref_count" ON "blobs" ("ref_count");
