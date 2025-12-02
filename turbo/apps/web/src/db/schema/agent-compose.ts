import {
  pgTable,
  uuid,
  jsonb,
  timestamp,
  text,
  varchar,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Agent Composes table
 * Metadata table for agent composes with HEAD pointer to current version
 */
export const agentComposes = pgTable(
  "agent_composes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Clerk user ID
    name: varchar("name", { length: 64 }).notNull(), // Agent name from compose
    headVersionId: varchar("head_version_id", { length: 64 }), // Points to latest version hash
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

/**
 * Agent Compose Versions table
 * Stores individual versions of each compose with content-addressable SHA-256 hash IDs
 * Version ID is computed from the content itself, enabling deduplication and verification
 */
export const agentComposeVersions = pgTable(
  "agent_compose_versions",
  {
    id: varchar("id", { length: 64 }).primaryKey(), // SHA-256 hash (content-addressed)
    composeId: uuid("compose_id")
      .notNull()
      .references(() => agentComposes.id, { onDelete: "cascade" }),
    content: jsonb("content").notNull(), // Full compose definition
    createdBy: text("created_by").notNull(), // User ID who created this version
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    composeIdIdx: index("idx_agent_compose_versions_compose_id").on(
      table.composeId,
    ),
  }),
);
