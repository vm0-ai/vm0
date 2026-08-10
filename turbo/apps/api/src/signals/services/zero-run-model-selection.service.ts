import type { CodexServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

interface ZeroRunModelSelection {
  readonly selectedModel: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
}

export async function resolveZeroRunModelSelection(
  db: ReadonlyDb,
  runId: string,
): Promise<ZeroRunModelSelection | undefined> {
  const [row] = await db
    .select({
      selectedModel: zeroRuns.selectedModel,
      codexServiceTier: zeroRuns.codexServiceTier,
    })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row;
}
