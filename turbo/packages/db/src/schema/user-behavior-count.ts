import {
  pgTable,
  text,
  integer,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";

export const userBehaviorCount = pgTable(
  "user_behavior_count",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    behaviorKey: text("behavior_key").notNull(),
    count: integer("count").notNull().default(0),
    firstAt: timestamp("first_at").defaultNow().notNull(),
    lastAt: timestamp("last_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        columns: [table.orgId, table.userId, table.behaviorKey],
      }),
    ];
  },
);
