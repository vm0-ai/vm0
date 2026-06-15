import {
  pgTable,
  uuid,
  timestamp,
  text,
  varchar,
  uniqueIndex,
  index,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";
import { modelProviders } from "./model-provider";

export type ZeroAgentVisibility = "public" | "private";

/**
 * Zero Agents table
 * Stores agent metadata (display name, description, sound) as first-class columns.
 * PK is the agent_composes.id (composeId) — one UUID used everywhere.
 */
export const zeroAgents = pgTable(
  "zero_agents",
  {
    id: uuid("id")
      .primaryKey()
      .references(
        () => {
          return agentComposes.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    owner: text("owner").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    visibility: varchar("visibility", { length: 16 })
      .$type<ZeroAgentVisibility>()
      .notNull()
      .default("public"),
    displayName: varchar("display_name", { length: 256 }),
    description: text("description"),
    sound: varchar("sound", { length: 64 }),
    avatarUrl: varchar("avatar_url", { length: 1024 }),
    customSkills: jsonb("custom_skills")
      .$type<string[]>()
      .notNull()
      .default([]),
    modelProviderId: uuid("model_provider_id").references(
      () => {
        return modelProviders.id;
      },
      { onDelete: "set null" },
    ),
    selectedModel: varchar("selected_model", { length: 255 }),
    preferPersonalProvider: boolean("prefer_personal_provider")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      orgNameIdx: uniqueIndex("idx_zero_agents_org_name").on(
        table.orgId,
        table.name,
      ),
      orgIdx: index("idx_zero_agents_org").on(table.orgId),
    };
  },
);
