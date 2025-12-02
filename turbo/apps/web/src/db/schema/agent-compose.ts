import {
  pgTable,
  uuid,
  jsonb,
  timestamp,
  text,
  varchar,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Agent Composes table
 * Stores agent compose from agent.yaml
 */
export const agentComposes = pgTable(
  "agent_composes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Clerk user ID
    name: varchar("name", { length: 64 }).notNull(), // Agent name from compose
    config: jsonb("config").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userNameIdx: uniqueIndex("idx_agent_composes_user_name").on(
      table.userId,
      table.name,
    ),
  }),
);
