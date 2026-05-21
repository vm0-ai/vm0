import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";
import { githubInstallations } from "./github-installation";

export type GithubLabelTriggerMode = "created_by_me" | "anyone";

/**
 * GitHub label listeners
 * Runs a configured agent when an issue or pull request receives a matching label.
 */
export const githubLabelListeners = pgTable(
  "github_label_listeners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id")
      .notNull()
      .references(
        () => {
          return githubInstallations.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    labelName: varchar("label_name", { length: 255 }).notNull(),
    labelNameNormalized: varchar("label_name_normalized", {
      length: 255,
    }).notNull(),
    triggerMode: varchar("trigger_mode", { length: 32 })
      .$type<GithubLabelTriggerMode>()
      .notNull()
      .default("created_by_me"),
    prompt: text("prompt").notNull(),
    composeId: uuid("compose_id")
      .notNull()
      .references(
        () => {
          return agentComposes.id;
        },
        { onDelete: "cascade" },
      ),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_github_label_listeners_installation_label").on(
        table.installationId,
        table.labelNameNormalized,
      ),
      index("idx_github_label_listeners_org").on(table.orgId),
      index("idx_github_label_listeners_installation").on(table.installationId),
    ];
  },
);
