import { initServices } from "../../lib/init-services";
import { grantOrgCredits } from "../../lib/zero/org/org-service";
import {
  deductFromExpiresRecords,
  expireCredits,
} from "../../lib/zero/credit/credit-expires-service";

// ---------------------------------------------------------------------------
// Re-exports: DB-direct seeders.
//
// These functions live in db-test-seeders/credits.ts but are re-exported
// here for backward compatibility — existing test files import from
// api-test-helpers and should continue to work unchanged.
// ---------------------------------------------------------------------------

export {
  updateOrgStripeFields,
  updateOrgAutoRecharge,
  updateOrgStripeSubscription,
  insertTestCreditPricing,
  insertCreditExpiresRecord,
  insertTestCreditUsage,
  insertTestClientCreditUsage,
  insertTestCreditUsageForRun,
  setTestCreditUsageCreatedAt,
  seedCreditUsageRecord,
  seedInsightsDaily,
  createCompletedRun,
} from "../db-test-seeders/credits";

// ---------------------------------------------------------------------------
// Re-exports: Assertion helpers.
// ---------------------------------------------------------------------------

export {
  getOrgBillingFields,
  getOrgAutoRechargeFields,
  findCreditExpiresRecords,
  findTestCreditUsage,
  findTestCreditUsagesByRunId,
  findTestClientCreditUsagesByRunId,
  findUsageDaily,
  findInsightsDaily,
} from "../db-test-assertions/credits";

// ---------------------------------------------------------------------------
// Service-layer wrappers.
//
// These call production service functions (not raw DB) and are valid
// API-based helpers.
// ---------------------------------------------------------------------------

/**
 * Grant credits to an org atomically. Wraps grantOrgCredits in a transaction.
 */
export async function grantCreditsToOrg(
  orgId: string,
  amount: number,
): Promise<void> {
  initServices();
  await globalThis.services.db.transaction(async (tx) => {
    await grantOrgCredits(tx, orgId, amount);
  });
}

/**
 * Deduct from expires records within a transaction (test helper).
 */
export async function testDeductFromExpiresRecords(
  orgId: string,
  amount: number,
): Promise<void> {
  initServices();
  await globalThis.services.db.transaction(async (tx) => {
    await deductFromExpiresRecords(tx, orgId, amount);
  });
}

/**
 * Expire credits within a transaction (test helper).
 * Returns the total expired amount.
 */
export async function testExpireCredits(orgId: string): Promise<number> {
  initServices();
  let result = 0;
  await globalThis.services.db.transaction(async (tx) => {
    result = await expireCredits(tx, orgId);
  });
  return result;
}
