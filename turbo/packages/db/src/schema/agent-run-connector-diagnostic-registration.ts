import { index, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import type { AgentRunConnectorDiagnosticRegistrationPayload } from "@okouai/db/jsonb-contracts/agent-run-connector-diagnostic-registration";
import { agentRuns } from "./agent-run";

export const agentRunConnectorDiagnosticRegistrations = pgTable(
  "agent_run_connector_diagnostic_registrations",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    payload: jsonb("payload")
      .$type<AgentRunConnectorDiagnosticRegistrationPayload>()
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("agent_run_connector_diagnostic_registrations_created_idx").on(
        table.createdAt,
        table.runId,
      ),
    ];
  },
);
