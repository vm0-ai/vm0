import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Test-only log of calls made to `/api/test/slack-mock/*` endpoints.
 *
 * The mock endpoints are hit by the preview's lambda when a Slack callback
 * posts a reply (`chat.postMessage`) after an agent run completes. Because
 * Vercel serverless functions can't share in-memory state, BATS e2e tests
 * need a persistent side channel to confirm "the callback actually posted
 * the reply we expected". Each mock writes one row here.
 *
 * Rows are cleared by `DELETE /api/test/slack-state?team_id=...`.
 * Schema is intentionally denormalized — the mock endpoints don't always
 * know the Slack workspace id, so callers filter by method + timestamp +
 * body contents.
 */
export const e2eSlackMockCallLog = pgTable(
  "e2e_slack_mock_call_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    method: varchar("method", { length: 64 }).notNull(),
    // Best-effort Slack workspace id extracted from the request body, or
    // null when the mock payload doesn't carry one (e.g. chat.postMessage
    // body has a channel id but no team id). Used for coarse filtering.
    teamId: varchar("team_id", { length: 255 }),
    // Best-effort Slack channel id extracted from the request body. Lets
    // BATS assertions scope to the DM / channel it's driving.
    channelId: varchar("channel_id", { length: 255 }),
    // Full request body as received by the mock. Kept as text (not jsonb)
    // because mock endpoints accept both form-encoded and JSON payloads.
    body: text("body").notNull(),
    // Parsed body when the content type was JSON, for easier jq queries.
    bodyJson: jsonb("body_json"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_e2e_slack_mock_call_log_created_at").on(table.createdAt),
      index("idx_e2e_slack_mock_call_log_method").on(table.method),
    ];
  },
);
