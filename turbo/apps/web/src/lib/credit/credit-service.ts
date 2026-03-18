import { eq, and, sql } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { creditUsage } from "../../db/schema/credit-usage";
import { creditPricing } from "../../db/schema/credit-pricing";
import { invalidateOrgCache } from "../org/org-cache-service";
import { logger } from "../logger";

const log = logger("service:credit");

interface CreditAtomicResult {
  totalCredits: number;
  processedCount: number;
}

/**
 * Atomically process pending credit_usage records for an org.
 *
 * Within a single advisory-locked transaction:
 * 1. Acquire org-level lock (independent from run queue lock)
 * 2. Fetch pending records and pricing
 * 3. Calculate and update each record
 * 4. Skip records with missing pricing (left as pending for retry)
 *
 * Returns the total credits charged and count, or undefined if nothing to process.
 */
async function creditAtomic(
  db: typeof globalThis.services.db,
  orgId: string,
): Promise<CreditAtomicResult | undefined> {
  return db.transaction(async (tx) => {
    // Org-level lock independent from run queue (which uses hashtext(orgId))
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('credit_' || ${orgId}))`,
    );

    // Fetch pending records for this org
    const pendingRecords = await tx
      .select()
      .from(creditUsage)
      .where(
        and(eq(creditUsage.orgId, orgId), eq(creditUsage.status, "pending")),
      );

    if (pendingRecords.length === 0) {
      return undefined;
    }

    // Fetch all pricing records and build lookup map
    const pricingRecords = await tx.select().from(creditPricing);
    const pricingByModel = new Map(pricingRecords.map((p) => [p.model, p]));

    let totalCredits = 0;
    let processedCount = 0;

    for (const record of pendingRecords) {
      const pricing = pricingByModel.get(record.model);
      if (!pricing) {
        // Skip records with missing pricing — cron retries next minute
        log.debug("Skipping credit record with missing pricing", {
          recordId: record.id,
          model: record.model,
        });
        continue;
      }

      // Calculate credits: ceil(inputTokens * inputTokenPrice / 1_000_000) +
      //                     ceil(outputTokens * outputTokenPrice / 1_000_000)
      const inputCredits = Math.ceil(
        (record.inputTokens * pricing.inputTokenPrice) / 1_000_000,
      );
      const outputCredits = Math.ceil(
        (record.outputTokens * pricing.outputTokenPrice) / 1_000_000,
      );
      const creditsCharged = inputCredits + outputCredits;

      await tx
        .update(creditUsage)
        .set({
          creditsCharged,
          status: "processed",
          processedAt: new Date(),
        })
        .where(eq(creditUsage.id, record.id));

      totalCredits += creditsCharged;
      processedCount++;
    }

    if (processedCount === 0) {
      return undefined;
    }

    return { totalCredits, processedCount };
  });
}

/**
 * Process pending credit records for an org and deduct from Clerk balance.
 *
 * 1. Atomically mark pending records as processed (under advisory lock)
 * 2. Read current Clerk balance and deduct
 * 3. Invalidate org_cache so next read re-fetches
 */
export async function processOrgCredits(orgId: string): Promise<void> {
  const result = await creditAtomic(globalThis.services.db, orgId);
  if (!result) return;

  const { totalCredits, processedCount } = result;

  // Read current balance from Clerk (outside transaction)
  const client = await clerkClient();
  const org = await client.organizations.getOrganization({
    organizationId: orgId,
  });

  const privateMetadata = org.privateMetadata as
    | Record<string, unknown>
    | undefined;
  const currentCredits =
    typeof privateMetadata?.credits === "number" ? privateMetadata.credits : 0;
  const newBalance = currentCredits - totalCredits;

  // Write updated balance back to Clerk
  await client.organizations.updateOrganizationMetadata(orgId, {
    privateMetadata: { credits: newBalance },
  });

  // Invalidate cache so next read re-fetches from Clerk
  await invalidateOrgCache(orgId);

  log.debug("Processed org credits", {
    orgId,
    processedCount,
    totalCredits,
    newBalance,
  });
}

/**
 * Cron entry point: find all orgs with pending credit records and process them.
 *
 * @returns Number of orgs processed
 */
export async function processStaleCredits(): Promise<number> {
  const db = globalThis.services.db;

  // Find distinct orgs with pending credit usage
  const orgs = await db
    .selectDistinct({ orgId: creditUsage.orgId })
    .from(creditUsage)
    .where(eq(creditUsage.status, "pending"));

  for (const { orgId } of orgs) {
    await processOrgCredits(orgId);
  }

  return orgs.length;
}
