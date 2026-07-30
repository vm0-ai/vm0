import { eq } from "drizzle-orm";
import { runOutputMaterializations } from "@vm0/db/schema/run-output-materialization";

import type { ReadonlyDb } from "../external/db";

export async function getRunOutputText(
  db: ReadonlyDb,
  runId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const [output] = await db
    .select({ text: runOutputMaterializations.latestOutputText })
    .from(runOutputMaterializations)
    .where(eq(runOutputMaterializations.runId, runId))
    .limit(1);
  signal.throwIfAborted();
  return output?.text ?? undefined;
}
