import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import type { E2eTeamsMockCallBodyJson } from "@vm0/db/jsonb-contracts/e2e-teams-mock-call-log";

/**
 * Test-only log of calls made to `/api/test/teams-mock/*` endpoints.
 *
 * Teams e2e tests run against Vercel previews, where serverless functions
 * cannot share in-memory mock state. Persisting mocked Bot Framework calls
 * lets BATS verify that callbacks posted the final agent reply back to Teams.
 */
export const e2eTeamsMockCallLog = pgTable(
  "e2e_teams_mock_call_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    method: varchar("method", { length: 64 }).notNull(),
    tenantId: varchar("tenant_id", { length: 255 }),
    conversationId: varchar("conversation_id", { length: 255 }),
    activityId: varchar("activity_id", { length: 255 }),
    body: text("body").notNull(),
    bodyJson: jsonb("body_json").$type<E2eTeamsMockCallBodyJson>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_e2e_teams_mock_call_log_created_at").on(table.createdAt),
      index("idx_e2e_teams_mock_call_log_method").on(table.method),
      index("idx_e2e_teams_mock_call_log_tenant").on(table.tenantId),
      index("idx_e2e_teams_mock_call_log_conversation").on(
        table.conversationId,
      ),
    ];
  },
);
