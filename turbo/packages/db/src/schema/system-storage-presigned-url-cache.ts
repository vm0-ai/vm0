import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const systemStoragePresignedUrlCache = pgTable(
  "system_storage_presigned_url_cache",
  {
    cacheKey: varchar("cache_key", { length: 64 }).primaryKey(),
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").notNull(),
    storageVersionId: varchar("storage_version_id", { length: 64 }).notNull(),
    publicEndpoint: boolean("public_endpoint").notNull(),
    ttlSeconds: integer("ttl_seconds").notNull(),
    presignedUrl: text("presigned_url").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    refreshAfter: timestamp("refresh_after").notNull(),
    lastRequestedAt: timestamp("last_requested_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_system_storage_presigned_url_cache_refresh_after").on(
        table.refreshAfter,
      ),
      index("idx_system_storage_presigned_url_cache_last_requested_at").on(
        table.lastRequestedAt,
      ),
      index("idx_system_storage_presigned_url_cache_active_refresh").on(
        table.lastRequestedAt,
        table.refreshAfter,
      ),
    ];
  },
);
