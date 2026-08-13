import {
  pgTable,
  text,
  timestamp,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";
import type { UserFeatureSwitches } from "@okouai/db/jsonb-contracts/user-feature-switches";

export const userFeatureSwitches = pgTable(
  "user_feature_switches",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    switches: jsonb("switches")
      .$type<UserFeatureSwitches>()
      .notNull()
      .default({}),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.orgId, table.userId] })];
  },
);
