import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Backfills legacy per-agent model-selection columns on a zero agent.
 *
 * Why product APIs cannot construct this state: agent model selection moved
 * to org model policies, so no current route writes `selected_model` or
 * `prefer_personal_provider` on the agent row. The columns only carry values
 * on rows that predate the cutover, and the update routes are expected to
 * clear them — which is exactly the behavior under test.
 */
export async function setAgentLegacyModelFields(
  agentId: string,
  fields: {
    readonly selectedModel: string;
    readonly preferPersonalProvider: boolean;
  },
): Promise<void> {
  await db()
    .update(zeroAgents)
    .set({
      selectedModel: fields.selectedModel,
      preferPersonalProvider: fields.preferPersonalProvider,
    })
    .where(eq(zeroAgents.id, agentId));
}
