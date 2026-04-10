import { pgTable, varchar, timestamp } from "drizzle-orm/pg-core";

/**
 * Slack event deduplication table.
 * Prevents duplicate agent runs when Slack retries event delivery
 * (e.g. due to cold-start timeouts exceeding 3 seconds).
 *
 * Slack's `event_id` (e.g. "Ev0PV52K25") is identical across retries
 * of the same event but unique per distinct event.
 */
export const slackEventDedup = pgTable("slack_event_dedup", {
  eventId: varchar("event_id", { length: 50 }).primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
