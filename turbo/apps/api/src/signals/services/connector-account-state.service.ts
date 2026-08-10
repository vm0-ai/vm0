import { gmailWatchStates } from "@vm0/db/schema/gmail-event";
import { googleCalendarWatchStates } from "@vm0/db/schema/google-calendar-event";
import { googleFormsWatchStates } from "@vm0/db/schema/google-forms-event";
import { googleWorkspaceEventSubscriptionStates } from "@vm0/db/schema/google-workspace-event";
import { mailDrafts } from "@vm0/db/schema/mail-draft";
import { eq } from "drizzle-orm";

import type { Db } from "../external/db";

/**
 * Removes state whose authority belongs to one external account while keeping
 * the logical connector row and durable product configuration intact.
 */
export async function clearConnectorAccountState(
  db: Db,
  connectorId: string,
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(gmailWatchStates)
    .where(eq(gmailWatchStates.connectorId, connectorId));
  signal.throwIfAborted();
  await db
    .delete(googleCalendarWatchStates)
    .where(eq(googleCalendarWatchStates.connectorId, connectorId));
  signal.throwIfAborted();
  await db
    .delete(googleFormsWatchStates)
    .where(eq(googleFormsWatchStates.connectorId, connectorId));
  signal.throwIfAborted();
  await db
    .delete(googleWorkspaceEventSubscriptionStates)
    .where(eq(googleWorkspaceEventSubscriptionStates.connectorId, connectorId));
  signal.throwIfAborted();
  await db
    .update(mailDrafts)
    .set({ connectorId: null })
    .where(eq(mailDrafts.connectorId, connectorId));
  signal.throwIfAborted();
}
