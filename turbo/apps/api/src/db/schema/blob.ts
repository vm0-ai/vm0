import {
  pgTable,
  varchar,
  bigint,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Blobs table
 * Content-addressable storage for file deduplication
 * Each blob is identified by its SHA-256 hash
 */
export const blobs = pgTable("blobs", {
  /** SHA-256 hash of the file content */
  hash: varchar("hash", { length: 64 }).primaryKey(),
  /** File size in bytes */
  size: bigint("size", { mode: "number" }).notNull(),
  /** Reference count for garbage collection */
  refCount: integer("ref_count").notNull().default(1),
  /** Timestamp when the blob was first uploaded */
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
