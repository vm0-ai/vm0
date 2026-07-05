import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
  text,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";

/**
 * Run-scoped encrypted snapshots for custom connector firewall auth fields.
 *
 * These refs are server-owned authorization data for /firewall/auth. They are
 * not part of the runner claim payload, and values stay encrypted until a
 * matching firewall auth request resolves a missing runtime secret alias.
 */
export const agentRunCustomConnectorAuthRefs = pgTable(
  "agent_run_custom_connector_auth_refs",
  {
    runId: uuid("run_id")
      .notNull()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    secretName: varchar("secret_name", { length: 255 }).notNull(),
    connectorId: uuid("connector_id").notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    key: varchar("key", { length: 64 }).notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.runId, table.secretName] }),
      index("idx_agent_run_custom_connector_auth_refs_expires").on(
        table.expiresAt,
      ),
    ];
  },
);
