import { eq } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { runOutputMaterializations } from "@vm0/db/schema/run-output-materialization";

import { logger } from "../../lib/log";
import type { ReadonlyDb } from "../external/db";
import { queryPreviousWriterRunOutput } from "./legacy-run-output-compat.service";

const log = logger("run-output");

export async function getRunOutputText(
  db: ReadonlyDb,
  runId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const [output] = await db
    .select({
      lastEventSequence: agentRuns.lastEventSequence,
      processedThroughSequence:
        runOutputMaterializations.processedThroughSequence,
      latestResultSequence: runOutputMaterializations.latestResultSequence,
      latestResultText: runOutputMaterializations.latestResultText,
      text: runOutputMaterializations.latestOutputText,
    })
    .from(agentRuns)
    .leftJoin(
      runOutputMaterializations,
      eq(runOutputMaterializations.runId, agentRuns.id),
    )
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();

  if (!output || output.text !== null) {
    return output?.text ?? undefined;
  }
  const lastEventSequence = output.lastEventSequence;
  if (lastEventSequence === null) {
    return undefined;
  }

  const projectionComplete =
    output.processedThroughSequence !== null &&
    output.processedThroughSequence >= lastEventSequence;
  const previousWriterResultWithoutText =
    output.latestResultSequence !== null &&
    output.latestResultSequence <= lastEventSequence &&
    output.latestResultText === null;
  if (projectionComplete && !previousWriterResultWithoutText) {
    return undefined;
  }

  log.warn("Using temporary previous-writer output compatibility read", {
    runId,
    lastEventSequence,
    processedThroughSequence: output.processedThroughSequence,
  });
  return await queryPreviousWriterRunOutput(runId, lastEventSequence, signal);
}
