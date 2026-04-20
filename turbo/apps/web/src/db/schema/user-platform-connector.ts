import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Per-user enablement of a platform-supplied connector.
 *
 * Platform connectors (e.g. nano-banana) do not store user credentials —
 * the platform injects its own auth at proxy time. All this row records is
 * that a given user in a given org has accepted the terms and enabled the
 * connector. A missing row means "not enabled". Kept separate from the
 * `connectors` table so the OAuth-specific columns there stay strictly
 * OAuth (no "NULL means platform" semantics leaking across the schema).
 */
export const userPlatformConnectors = pgTable(
  "user_platform_connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Unique (org_id, user_id, type): covers `org_id` as leftmost prefix
      // for list-by-org scans — no separate org_id index needed.
      uniqueIndex("idx_user_platform_connectors_org_user_type").on(
        table.orgId,
        table.userId,
        table.type,
      ),
    ];
  },
);
