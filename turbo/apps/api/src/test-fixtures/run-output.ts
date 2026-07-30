import { runOutputMaterializations } from "@vm0/db/schema/run-output-materialization";

import { db } from "../lib/db";

export async function seedRunOutputTextFixture(args: {
  readonly runId: string;
  readonly text: string;
  readonly sequenceNumber?: number;
}): Promise<void> {
  const sequenceNumber = args.sequenceNumber ?? 0;
  await db()
    .insert(runOutputMaterializations)
    .values({
      runId: args.runId,
      processedThroughSequence: sequenceNumber,
      latestResultSequence: sequenceNumber,
      latestResultText: args.text,
      latestOutputSequence: sequenceNumber,
      latestOutputText: args.text,
    })
    .onConflictDoUpdate({
      target: runOutputMaterializations.runId,
      set: {
        processedThroughSequence: sequenceNumber,
        latestResultSequence: sequenceNumber,
        latestResultText: args.text,
        latestOutputSequence: sequenceNumber,
        latestOutputText: args.text,
      },
    });
}
