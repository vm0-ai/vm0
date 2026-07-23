/**
 * Test fixtures for migration-era model usage observation state.
 */
import { modelUsageObservationLegacyKey } from "@vm0/db/schema/model-usage-observation";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

/**
 * Represents a legacy observation committed before the compatibility ledger
 * was installed.
 */
export async function removeModelUsageObservationLegacyClaimFixture(
  idempotencyKey: string,
): Promise<void> {
  await createStore()
    .set(writeDb$)
    .delete(modelUsageObservationLegacyKey)
    .where(eq(modelUsageObservationLegacyKey.idempotencyKey, idempotencyKey));
}
