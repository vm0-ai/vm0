import { lt } from "drizzle-orm";
import { slackEventDedup } from "../../../db/schema/slack-event-dedup";
import { logger } from "../../shared/logger";

const log = logger("slack-org:event-dedup");

/**
 * Check if a Slack event has already been processed, and mark it as processed
 * if not.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING for atomic dedup:
 * - If the event_id does not exist → inserts and returns true (proceed)
 * - If the event_id already exists → no-op and returns false (skip)
 *
 * This prevents duplicate agent runs when Slack retries event delivery
 * due to cold-start timeouts exceeding the 3-second window.
 */
export async function claimSlackEvent(eventId: string): Promise<boolean> {
  const result = await globalThis.services.db
    .insert(slackEventDedup)
    .values({ eventId })
    .onConflictDoNothing()
    .returning({ eventId: slackEventDedup.eventId });

  if (result.length === 0) {
    log.debug(`Duplicate Slack event ${eventId}, skipping`);
    return false;
  }

  return true;
}

/**
 * Delete dedup records older than the given age.
 * Called by the cleanup cron to prevent unbounded table growth.
 */
export async function cleanupExpiredSlackEvents(
  maxAgeMs: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const deleted = await globalThis.services.db
    .delete(slackEventDedup)
    .where(lt(slackEventDedup.createdAt, cutoff));

  return deleted.rowCount ?? 0;
}
