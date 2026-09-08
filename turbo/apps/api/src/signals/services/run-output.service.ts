import { eq } from "drizzle-orm";
import { runOutputMaterializations } from "@okouai/db/schema/run-output-materialization";
import { visiblePiMemoryCitationText } from "@okouai/api-contracts/contracts/pi-memory-citations";

import type { ReadonlyDb } from "../external/db";

export async function getRunOutputText(
  db: ReadonlyDb,
  runId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const [output] = await db
    .select({
      text: runOutputMaterializations.latestOutputText,
    })
    .from(runOutputMaterializations)
    .where(eq(runOutputMaterializations.runId, runId))
    .limit(1);
  signal.throwIfAborted();
  return output?.text === null || output?.text === undefined
    ? undefined
    : visiblePiMemoryCitationText(output.text);
}
