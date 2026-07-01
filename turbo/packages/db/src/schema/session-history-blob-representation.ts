import {
  bigint,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { blobs } from "./blob";

export const sessionHistoryBlobRepresentations = pgTable(
  "session_history_blob_representations",
  {
    rawHash: varchar("raw_hash", { length: 64 })
      .notNull()
      .references(
        () => {
          return blobs.hash;
        },
        { onDelete: "cascade" },
      ),
    encoding: varchar("encoding", { length: 16 }).notNull(),
    rawSize: bigint("raw_size", { mode: "number" }).notNull(),
    encodedSize: bigint("encoded_size", { mode: "number" }).notNull(),
    objectKey: varchar("object_key", { length: 512 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        columns: [table.rawHash, table.encoding],
        name: "session_history_blob_representations_pkey",
      }),
    ];
  },
);
