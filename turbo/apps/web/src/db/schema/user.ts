import { pgTable, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { scopes } from "./scope";

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: uuid("scope_id").references(() => scopes.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    scopeIdx: index("idx_users_scope").on(table.scopeId),
  }),
);
