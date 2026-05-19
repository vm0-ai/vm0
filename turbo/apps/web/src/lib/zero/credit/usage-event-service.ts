import { eq, and, sql } from "drizzle-orm";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { deductOrgCredits } from "../org/org-service";
import {
  deductFromExpiresRecords,
  expireCredits,
} from "./credit-expires-service";
import { triggerAutoRecharge } from "../billing/auto-recharge-service";
import { evaluateMemberCaps } from "./member-credit-cap-service";
import { logger } from "../../shared/logger";

const log = logger("service:usage-event");

/**
 * Atomically process pending usage_event records for an org and deduct the
 * total from the org's credit balance.
 *
 * Within a single advisory-locked transaction:
 * 1. Acquire the shared `credit_` org-level lock
 * 2. Fetch pending records and the pricing table
 * 3. For each record, resolve pricing in order:
 *    a. Exact `(kind, provider, category)` match → bill at that rate
 *    b. `(kind, provider, "__fallback__")` safety-net row → bill at that
 *       rate, stamp `billing_error = 'fallback_pricing'`
 *    c. Neither → charge zero, stamp `billing_error = 'missing_pricing'`
 * 4. Update each record with creditsCharged = ceil(quantity × unit_price /
 *    unit_size) and status = 'processed'
 * 5. Deduct the total from org_metadata.credits
 *
 * Uses the `credit_` advisory lock while settling expires records and
 * deducting from org_metadata.credits, so per-org credit updates remain
 * serialized.
 */
export async function processOrgUsageEvents(orgId: string): Promise<void> {
  const db = globalThis.services.db;

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('credit_' || ${orgId}))`,
    );

    const pendingRecords = await tx
      .select()
      .from(usageEvent)
      .where(
        and(eq(usageEvent.orgId, orgId), eq(usageEvent.status, "pending")),
      );

    if (pendingRecords.length === 0) {
      return undefined;
    }

    const pricingRecords = await tx.select().from(usagePricing);
    const pricingByKey = new Map(
      pricingRecords.map((p) => {
        return [`${p.kind}|${p.provider}|${p.category}`, p];
      }),
    );

    let totalCredits = 0;
    let processedCount = 0;
    const affectedUserIds = new Set<string>();

    for (const record of pendingRecords) {
      affectedUserIds.add(record.userId);
      // Exact (kind, provider, category) match; fall back to the
      // (kind, provider, "__fallback__") row when present so synthetic
      // per-request categories (e.g. `includes.<unknown_key>` from the
      // X connector) bill at the provider's safety-net rate instead of
      // dropping to zero. Only dead-end into missing_pricing when even
      // the fallback row is unseeded.
      const exactPricing = pricingByKey.get(
        `${record.kind}|${record.provider}|${record.category}`,
      );
      const pricing =
        exactPricing ??
        pricingByKey.get(`${record.kind}|${record.provider}|__fallback__`);
      if (pricing && !exactPricing) {
        log.error("Missing usage_pricing — billed at fallback rate", {
          runId: record.runId,
          idempotencyKey: record.idempotencyKey,
          orgId: record.orgId,
          userId: record.userId,
          kind: record.kind,
          provider: record.provider,
          category: record.category,
          quantity: record.quantity,
          fallbackUnitPrice: pricing.unitPrice,
        });
      }
      if (!pricing) {
        await tx
          .update(usageEvent)
          .set({
            creditsCharged: 0,
            status: "processed",
            processedAt: new Date(),
            billingError: "missing_pricing",
          })
          .where(eq(usageEvent.id, record.id));

        processedCount++;

        log.error("Missing usage_pricing — charged zero", {
          runId: record.runId,
          idempotencyKey: record.idempotencyKey,
          orgId: record.orgId,
          userId: record.userId,
          kind: record.kind,
          provider: record.provider,
          category: record.category,
          quantity: record.quantity,
        });
        continue;
      }

      const creditsCharged = Math.ceil(
        (record.quantity * pricing.unitPrice) / pricing.unitSize,
      );

      await tx
        .update(usageEvent)
        .set({
          creditsCharged,
          status: "processed",
          processedAt: new Date(),
          billingError: exactPricing ? null : "fallback_pricing",
        })
        .where(eq(usageEvent.id, record.id));

      totalCredits += creditsCharged;
      processedCount++;
    }

    if (totalCredits > 0) {
      await expireCredits(tx, orgId);
      await deductOrgCredits(tx, orgId, totalCredits);
      await deductFromExpiresRecords(tx, orgId, totalCredits);
    }

    return { totalCredits, processedCount, affectedUserIds };
  });

  if (!result) return;

  log.debug("Processed org usage events", {
    orgId,
    processedCount: result.processedCount,
    totalCredits: result.totalCredits,
  });

  if (result.totalCredits > 0) {
    triggerAutoRecharge(orgId).catch((err) => {
      log.warn("Auto-recharge trigger failed", {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  if (result.totalCredits > 0 && result.affectedUserIds.size > 0) {
    await evaluateMemberCaps(orgId, [...result.affectedUserIds]);
  }
}
