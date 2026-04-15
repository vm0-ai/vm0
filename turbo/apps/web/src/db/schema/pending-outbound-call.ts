import { pgTable, varchar, text, uuid, timestamp } from "drizzle-orm/pg-core";

/**
 * Tracks outbound phone calls made in fire-and-forget mode.
 * When these calls end, the call_ended webhook creates a new agent run
 * with the transcript so the agent can process the user's response.
 *
 * Rows are deleted after processing (or after TTL expiry).
 */
export const pendingOutboundCalls = pgTable("pending_outbound_calls", {
  callId: varchar("call_id", { length: 255 }).primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  sessionId: uuid("session_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
