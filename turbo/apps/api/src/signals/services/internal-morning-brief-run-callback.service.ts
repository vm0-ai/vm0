import { command } from "ccstate";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";

const callbackPayloadSchema = z.object({
  deliveryId: z.string().uuid(),
});

const LEGACY_CUTOVER_ERROR =
  "Legacy Morning Brief stopped during the Official Workflow cutover";

/**
 * Deployment fallback for callbacks persisted by an outgoing API version.
 * It is deliberately terminal and cannot render or enqueue an email. Phase B
 * removes it after #30264's released zero-traffic gate proves there are no
 * legacy callback attempts or retries left.
 */
export async function handleMorningBriefEmailInternalCallback(
  db: Db,
  envelope: InternalRunCallbackEnvelope,
): Promise<InternalRunCallbackDispatchResult> {
  if (envelope.status === "progress") {
    return { success: true, skipped: true };
  }

  const payload = callbackPayloadSchema.safeParse(envelope.payload);
  if (!payload.success) {
    return { success: false, error: "Invalid morning brief callback payload" };
  }

  const [retired] = await db
    .update(morningBriefDeliveries)
    .set({
      status: "failed",
      error: LEGACY_CUTOVER_ERROR,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(morningBriefDeliveries.id, payload.data.deliveryId),
        inArray(morningBriefDeliveries.status, [
          "collecting",
          "queued",
          "running",
        ]),
      ),
    )
    .returning({ id: morningBriefDeliveries.id });

  return retired ? { success: true } : { success: true, skipped: true };
}

export const handleMorningBriefEmailInternalCallback$ = command(
  async (
    { set },
    envelope: InternalRunCallbackEnvelope,
    _signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    return await handleMorningBriefEmailInternalCallback(
      set(writeDb$),
      envelope,
    );
  },
);
