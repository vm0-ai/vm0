import { eq, and, sql, inArray, sum } from "drizzle-orm";
import { creditUsage } from "../../../db/schema/credit-usage";
import { proxyCreditUsage } from "../../../db/schema/proxy-credit-usage";
import { creditPricing } from "../../../db/schema/credit-pricing";
import { deductOrgCredits } from "../org/org-service";
import { deductFromExpiresRecords } from "./credit-expires-service";
import { triggerAutoRecharge } from "../billing/auto-recharge-service";
import { evaluateMemberCaps } from "./member-credit-cap-service";
import { logger } from "../../shared/logger";

const log = logger("service:credit");

/**
 * Atomically process pending credit_usage records for an org
 * and deduct the total from the org's credit balance.
 *
 * Within a single advisory-locked transaction:
 * 1. Acquire org-level lock (independent from run queue lock)
 * 2. Fetch pending records and pricing
 * 3. Calculate and update each record
 * 4. Mark records with no matching pricing as processed with zero charge
 * 5. Deduct total credits from the org table
 */
export async function processOrgCredits(orgId: string): Promise<void> {
  const db = globalThis.services.db;

  const result = await db.transaction(async (tx) => {
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

    // Fetch all pricing records and build lookup map keyed by "model|modelProvider"
    const pricingRecords = await tx.select().from(creditPricing);
    const pricingByKey = new Map(
      pricingRecords.map((p) => {
        return [`${p.model}|${p.modelProvider}`, p];
      }),
    );

    let totalCredits = 0;
    let processedCount = 0;
    const affectedUserIds = new Set<string>();
    const affectedRunIds = new Set<string>();

    for (const record of pendingRecords) {
      affectedUserIds.add(record.userId);
      if (record.runId) affectedRunIds.add(record.runId);
      const pricing = pricingByKey.get(
        `${record.model}|${record.modelProvider}`,
      );
      if (!pricing) {
        // No matching pricing for this model+provider combo — no charge
        // (user's own provider or unconfigured provider)
        await tx
          .update(creditUsage)
          .set({
            creditsCharged: 0,
            status: "processed",
            processedAt: new Date(),
          })
          .where(eq(creditUsage.id, record.id));

        processedCount++;

        log.debug("No matching pricing — zero charge", {
          recordId: record.id,
          model: record.model,
          modelProvider: record.modelProvider,
        });
        continue;
      }

      // Calculate credits: ceil(tokens * price / 1_000_000) for each token type
      const inputCredits = Math.ceil(
        (record.inputTokens * pricing.inputTokenPrice) / 1_000_000,
      );
      const outputCredits = Math.ceil(
        (record.outputTokens * pricing.outputTokenPrice) / 1_000_000,
      );
      const cacheReadCredits = Math.ceil(
        (record.cacheReadInputTokens * pricing.cacheReadTokenPrice) / 1_000_000,
      );
      const cacheCreationCredits = Math.ceil(
        (record.cacheCreationInputTokens * pricing.cacheCreationTokenPrice) /
          1_000_000,
      );
      const creditsCharged =
        inputCredits + outputCredits + cacheReadCredits + cacheCreationCredits;

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

    // Deduct total credits from the org table within the same transaction
    if (totalCredits > 0) {
      await deductOrgCredits(tx, orgId, totalCredits);
      await deductFromExpiresRecords(tx, orgId, totalCredits);
    }

    return { totalCredits, processedCount, affectedUserIds, affectedRunIds };
  });

  if (!result) return;

  log.debug("Processed org credits", {
    orgId,
    processedCount: result.processedCount,
    totalCredits: result.totalCredits,
  });

  // Compare client-reported usage against proxy-observed usage per run.
  // Mismatches indicate potential tampering or reporting bugs.
  if (result.affectedRunIds.size > 0) {
    try {
      await compareProxyUsage(result.affectedRunIds, orgId);
    } catch (err) {
      log.warn("Proxy usage comparison failed", {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // After deduction, check if auto-recharge should trigger.
  // Fire-and-forget: errors are logged internally, never propagated.
  if (result.totalCredits > 0) {
    triggerAutoRecharge(orgId).catch((err) => {
      log.warn("Auto-recharge trigger failed", {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Evaluate member credit caps for affected users (awaited as part of settlement)
  if (result.totalCredits > 0 && result.affectedUserIds.size > 0) {
    await evaluateMemberCaps(orgId, [...result.affectedUserIds]);
  }
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

/**
 * Compare client-reported credit_usage against proxy-observed proxy_credit_usage
 * for a set of runs.  Logs an error for each run where the token totals diverge.
 *
 * Comparison is by-run aggregate (sum of all records per runId) because the two
 * tables have different granularity (result-level vs API-call-level).
 */
async function compareProxyUsage(
  runIds: Set<string>,
  orgId: string,
): Promise<void> {
  const db = globalThis.services.db;
  const ids = [...runIds];
  if (ids.length === 0) return;

  // Client-reported totals (from credit_usage, already processed)
  const clientRows = await db
    .select({
      runId: creditUsage.runId,
      inputTokens: sum(creditUsage.inputTokens).mapWith(Number),
      outputTokens: sum(creditUsage.outputTokens).mapWith(Number),
      cacheReadInputTokens: sum(creditUsage.cacheReadInputTokens).mapWith(
        Number,
      ),
      cacheCreationInputTokens: sum(
        creditUsage.cacheCreationInputTokens,
      ).mapWith(Number),
      webSearchRequests: sum(creditUsage.webSearchRequests).mapWith(Number),
    })
    .from(creditUsage)
    .where(and(eq(creditUsage.orgId, orgId), inArray(creditUsage.runId, ids)))
    .groupBy(creditUsage.runId);

  // Proxy-observed totals (from proxy_credit_usage)
  const proxyRows = await db
    .select({
      runId: proxyCreditUsage.runId,
      inputTokens: sum(proxyCreditUsage.inputTokens).mapWith(Number),
      outputTokens: sum(proxyCreditUsage.outputTokens).mapWith(Number),
      cacheReadInputTokens: sum(proxyCreditUsage.cacheReadInputTokens).mapWith(
        Number,
      ),
      cacheCreationInputTokens: sum(
        proxyCreditUsage.cacheCreationInputTokens,
      ).mapWith(Number),
      webSearchRequests: sum(proxyCreditUsage.webSearchRequests).mapWith(
        Number,
      ),
    })
    .from(proxyCreditUsage)
    .where(
      and(
        eq(proxyCreditUsage.orgId, orgId),
        inArray(proxyCreditUsage.runId, ids),
      ),
    )
    .groupBy(proxyCreditUsage.runId);

  const proxyByRun = new Map(
    proxyRows.map((r) => {
      return [r.runId, r];
    }),
  );

  for (const client of clientRows) {
    if (!client.runId) continue;
    const proxy = proxyByRun.get(client.runId);
    if (!proxy) {
      // No proxy data yet — might arrive later, not an error
      continue;
    }

    const fields = [
      "inputTokens",
      "outputTokens",
      "cacheReadInputTokens",
      "cacheCreationInputTokens",
      "webSearchRequests",
    ] as const;

    for (const field of fields) {
      const clientVal = client[field] ?? 0;
      const proxyVal = proxy[field] ?? 0;
      if (clientVal !== proxyVal) {
        log.error("Proxy usage mismatch", {
          orgId,
          runId: client.runId,
          field,
          clientValue: clientVal,
          proxyValue: proxyVal,
        });
      }
    }
  }
}
