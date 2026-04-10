import {
  pgTable,
  text,
  timestamp,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";

export const userFeatureSwitches = pgTable(
  "user_feature_switches",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    switches: jsonb("switches")
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.orgId, table.userId] })];
  },
);
