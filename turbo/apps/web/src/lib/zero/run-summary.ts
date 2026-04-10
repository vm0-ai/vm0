import "server-only";
import { eq } from "drizzle-orm";
import { zeroRuns } from "../../db/schema/zero-run";
import { generateRunSummary } from "./ai/lightweight-model";
import { logger } from "../shared/logger";

const log = logger("run-summary");

/**
 * Generate and persist a brief AI summary for a completed run.
 *
 * Best-effort: failures are logged but never thrown so callers
 * (integration callbacks) are not disrupted.
 */
export async function saveRunSummary(
  runId: string,
  triggerSource: string,
  prompt: string,
  resultText: string,
): Promise<void> {
  try {
    const summary = await generateRunSummary(triggerSource, prompt, resultText);
    if (!summary) return;

    await globalThis.services.db
      .update(zeroRuns)
      .set({ summary })
      .where(eq(zeroRuns.id, runId));
  } catch (err) {
    log.warn("Failed to generate run summary", { runId, err });
  }
}
