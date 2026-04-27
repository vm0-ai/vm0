import "server-only";
import { eq } from "drizzle-orm";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { generateRunSummary } from "./ai/lightweight-model";
import { logger } from "../shared/logger";

const log = logger("run-summary");

/**
 * Generate and persist a brief AI summary for a completed run.
 *
 * Errors are caught and logged internally — summaries are non-critical
 * and must never break callback processing.
 */
export async function saveRunSummary(
  runId: string,
  triggerSource: string,
  prompt: string,
  resultText: string,
): Promise<void> {
  try {
    const summary = await generateRunSummary(triggerSource, prompt, resultText);
    if (!summary) {
      log.warn("Run summary generation returned null (API key missing?)", {
        runId,
        triggerSource,
      });
      return;
    }

    await globalThis.services.db
      .update(zeroRuns)
      .set({ summary })
      .where(eq(zeroRuns.id, runId));
  } catch (err) {
    log.warn("Failed to generate run summary", { runId, err });
  }
}
