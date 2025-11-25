import {
  pgTable,
  uuid,
  text,
  varchar,
  bigint,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const volumes = pgTable(
  "volumes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    s3Prefix: text("s3_prefix").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    fileCount: integer("file_count").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userNameIdx: uniqueIndex("idx_volumes_user_name").on(
      table.userId,
      table.name,
    ),
  }),
);
