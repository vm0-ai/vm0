import type { CodexServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import type { ReadonlyDb } from "../external/db";

interface ZeroRunModelSelection {
  readonly selectedModel: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
}

// Migration 0877 can briefly lag a newly deployed API. Projecting the row to
// JSON keeps footer reads legal on the old schema because a missing key yields
// null instead of PostgreSQL 42703. Remove this projection after migration 0877
// is deployed in every environment and is outside the API rollback window.
const rolloutSafeCodexServiceTierDecoder = zodDriverValueDecoder(
  z.enum(["fast"]).nullable(),
);
const rolloutSafeCodexServiceTier = sql`
  to_jsonb(${zeroRuns}) ->> 'codex_service_tier'
`.mapWith(rolloutSafeCodexServiceTierDecoder);

export async function resolveZeroRunModelSelection(
  db: ReadonlyDb,
  runId: string,
): Promise<ZeroRunModelSelection | undefined> {
  const [row] = await db
    .select({
      selectedModel: zeroRuns.selectedModel,
      codexServiceTier: rolloutSafeCodexServiceTier,
    })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row;
}
