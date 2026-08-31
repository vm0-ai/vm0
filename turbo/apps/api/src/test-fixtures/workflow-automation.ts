import { workflowAutomations } from "@okouai/db/schema/workflow";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Reproduces the nullable Gmail account projection written by the previous API
 * version. No production endpoint can construct this rollout-only state.
 */
export async function clearWorkflowAutomationEventConnectorFixture(
  automationId: string,
): Promise<void> {
  await db()
    .update(workflowAutomations)
    .set({ eventConnectorId: null })
    .where(eq(workflowAutomations.id, automationId));
}
