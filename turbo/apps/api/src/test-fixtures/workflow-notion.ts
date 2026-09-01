import {
  notionWebhookSecrets,
  notionWorkflowPendingEvents,
} from "@okouai/db/schema/notion-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Constructs the "Notion webhook not yet verified" Given by removing all
 * stored verification secrets.
 *
 * Why product APIs cannot construct this state: the Notion verification
 * handshake is a global one-shot — once any verification token is active,
 * `POST /api/webhooks/notion` rejects every further verification attempt
 * (401), so on the shared persistent test database the pre-verification
 * state is unreachable after the first test run that ever verified.
 */
export async function resetNotionWebhookVerification(): Promise<void> {
  await db().delete(notionWebhookSecrets);
}

/** Constructs a pre-migration automation that has no relational account projection. */
export async function clearNotionAutomationConnectorProjection(
  automationId: string,
): Promise<void> {
  await db()
    .update(workflowAutomations)
    .set({ eventConnectorId: null })
    .where(eq(workflowAutomations.id, automationId));
}

/** Constructs a pre-migration pending event that has no account projection. */
export async function clearNotionPendingConnectorProjection(
  automationId: string,
): Promise<void> {
  await db()
    .update(notionWorkflowPendingEvents)
    .set({ connectorId: null })
    .where(
      and(
        eq(notionWorkflowPendingEvents.automationId, automationId),
        eq(notionWorkflowPendingEvents.status, "pending"),
      ),
    );
}
