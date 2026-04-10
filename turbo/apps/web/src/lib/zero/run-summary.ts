import "server-only";
import { eq } from "drizzle-orm";
import { zeroRuns } from "../../db/schema/zero-run";
import { generateRunSummary } from "./ai/lightweight-model";

/**
 * Generate and persist a brief AI summary for a completed run.
 *
 * Callers are responsible for error handling (typically a try-catch
 * that logs and continues, since summaries are non-critical).
 */
export async function saveRunSummary(
  runId: string,
  triggerSource: string,
  prompt: string,
  resultText: string,
): Promise<void> {
  const summary = await generateRunSummary(triggerSource, prompt, resultText);
  if (!summary) return;

  await globalThis.services.db
    .update(zeroRuns)
    .set({ summary })
    .where(eq(zeroRuns.id, runId));
}
