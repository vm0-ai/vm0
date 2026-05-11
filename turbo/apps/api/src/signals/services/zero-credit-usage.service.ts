import { command } from "ccstate";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { logger } from "../../lib/log";
import { triggerAutoRecharge$ } from "./zero-credit-recharge.service";
import { evaluateMemberCaps$ } from "./zero-member-credit-cap-evaluator.service";

const L = logger("CreditUsage");

type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function deductOrgCredits(
  tx: WriteTx,
  orgId: string,
  amount: number,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO org_metadata (org_id, credits, created_at, updated_at)
        VALUES (${orgId}, ${-amount}, now(), now())
        ON CONFLICT (org_id)
        DO UPDATE SET credits = org_metadata.credits - ${amount}, updated_at = now()`,
  );
}

async function expireCredits(tx: WriteTx, orgId: string): Promise<number> {
  const expired = await tx
    .select({
      id: creditExpiresRecord.id,
      remaining: creditExpiresRecord.remaining,
    })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        lte(creditExpiresRecord.expiresAt, nowDate()),
        gt(creditExpiresRecord.remaining, 0),
      ),
    )
    .for("update");

  if (expired.length === 0) {
    return 0;
  }

  let totalExpired = 0;
  for (const record of expired) {
    totalExpired += record.remaining;
    await tx
      .update(creditExpiresRecord)
      .set({ remaining: 0 })
      .where(eq(creditExpiresRecord.id, record.id));
  }

  if (totalExpired > 0) {
    await tx
      .update(orgMetadata)
      .set({
        credits: sql`GREATEST(${orgMetadata.credits} - ${totalExpired}, 0)`,
        updatedAt: nowDate(),
      })
      .where(eq(orgMetadata.orgId, orgId));
  }

  L.debug("expired credits settled", { orgId, totalExpired });
  return totalExpired;
}

async function deductFromExpiresRecords(
  tx: WriteTx,
  orgId: string,
  amount: number,
): Promise<void> {
  if (amount <= 0) {
    return;
  }

  const records = await tx
    .select({
      id: creditExpiresRecord.id,
      remaining: creditExpiresRecord.remaining,
    })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        gt(creditExpiresRecord.remaining, 0),
        gt(creditExpiresRecord.expiresAt, nowDate()),
      ),
    )
    .orderBy(asc(creditExpiresRecord.expiresAt))
    .for("update");

  let left = amount;
  for (const record of records) {
    if (left <= 0) {
      break;
    }
    const deduct = Math.min(left, record.remaining);
    await tx
      .update(creditExpiresRecord)
      .set({ remaining: record.remaining - deduct })
      .where(eq(creditExpiresRecord.id, record.id));
    left -= deduct;
  }
  // If left > 0, the excess comes from non-expiring credits — that's fine.
}

/**
 * Atomically process pending usage_event records for an org and deduct
 * the total from the org's credit balance.
 *
 * Mirrors apps/web's `processOrgUsageEvents`. The transactional invariant
 * is critical: events are marked processed IFF the credit deduction
 * succeeds. If any helper throws, the whole transaction rolls back.
 *
 * Acquires `pg_advisory_xact_lock(hashtext('credit_' || orgId))` —
 * verbatim same key string as web so api and web serialize correctly on
 * the same org during rollout.
 *
 * After the transaction commits and credits are deducted, fires two
 * cascade steps sequentially (both bounded by the route handler's outer
 * waitUntil envelope so end-user latency is unaffected):
 *
 *  - `triggerAutoRecharge$` — Stripe top-up when balance crosses the
 *    recharge threshold. Errors in the Stripe path are caught inside the
 *    trigger Command (clearPendingFlag in catch).
 *  - `evaluateMemberCaps$` — per-user spend-cap enforcement. Gated on
 *    `affectedUserIds.size > 0` so a totalCredits-only-from-fallback-
 *    pricing path skips the cap pass. Race-safe via the cap-disable
 *    WHERE predicate that re-checks `creditEnabled = true`.
 */
export const processOrgUsageEvents$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);

    const { totalCredits, affectedUserIds } = await writeDb.transaction(
      async (tx) => {
        // Same advisory key as web: 'credit_' prefix + orgId.
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
          return {
            totalCredits: 0,
            affectedUserIds: new Set<string>(),
          };
        }

        const pricingRecords = await tx.select().from(usagePricing);
        const pricingByKey = new Map(
          pricingRecords.map((p) => {
            return [`${p.kind}|${p.provider}|${p.category}`, p];
          }),
        );

        const affectedUserIds = new Set<string>();
        let totalCredits = 0;
        for (const record of pendingRecords) {
          affectedUserIds.add(record.userId);
          const exactPricing = pricingByKey.get(
            `${record.kind}|${record.provider}|${record.category}`,
          );
          const pricing =
            exactPricing ??
            pricingByKey.get(`${record.kind}|${record.provider}|__fallback__`);

          if (!pricing) {
            await tx
              .update(usageEvent)
              .set({
                creditsCharged: 0,
                status: "processed",
                processedAt: nowDate(),
                billingError: "missing_pricing",
              })
              .where(eq(usageEvent.id, record.id));
            L.error("Missing usage_pricing — charged zero", {
              orgId,
              runId: record.runId,
              idempotencyKey: record.idempotencyKey,
              userId: record.userId,
              kind: record.kind,
              provider: record.provider,
              category: record.category,
              quantity: record.quantity,
            });
            continue;
          }

          if (!exactPricing) {
            L.error("Missing usage_pricing — billed at fallback rate", {
              orgId,
              runId: record.runId,
              idempotencyKey: record.idempotencyKey,
              userId: record.userId,
              kind: record.kind,
              provider: record.provider,
              category: record.category,
              quantity: record.quantity,
              fallbackUnitPrice: pricing.unitPrice,
            });
          }

          const creditsCharged = Math.ceil(
            (record.quantity * pricing.unitPrice) / pricing.unitSize,
          );
          await tx
            .update(usageEvent)
            .set({
              creditsCharged,
              status: "processed",
              processedAt: nowDate(),
              billingError: exactPricing ? null : "fallback_pricing",
            })
            .where(eq(usageEvent.id, record.id));
          totalCredits += creditsCharged;
        }
        signal.throwIfAborted();

        if (totalCredits > 0) {
          // Order matters: settle expired credits BEFORE the new
          // deduction. expireCredits zeros out rows whose expires_at <=
          // now() so deductFromExpiresRecords doesn't touch them.
          await expireCredits(tx, orgId);
          await deductOrgCredits(tx, orgId, totalCredits);
          await deductFromExpiresRecords(tx, orgId, totalCredits);
        }
        signal.throwIfAborted();
        return { totalCredits, affectedUserIds };
      },
    );
    signal.throwIfAborted();

    if (totalCredits > 0) {
      // Auto-recharge runs OUTSIDE the deduction transaction (Stripe
      // can't be transactional with DB). triggerAutoRecharge$ catches
      // its own errors (clearPendingFlag in catch); the await here is
      // bounded by the route handler's outer waitUntil envelope.
      await set(triggerAutoRecharge$, orgId, signal);
      signal.throwIfAborted();
    }

    if (totalCredits > 0 && affectedUserIds.size > 0) {
      // Re-evaluate per-user spend caps for users who consumed credits
      // in this batch. Sequential await mirrors triggerAutoRecharge$
      // above; the route handler's outer waitUntil envelope keeps end-
      // user latency unaffected. Race-safe: the cap-disable WHERE
      // predicate re-checks creditEnabled=true so a concurrent admin
      // re-enable (or cap change) no-ops the disable.
      await set(
        evaluateMemberCaps$,
        { orgId, affectedUserIds: [...affectedUserIds] },
        signal,
      );
      signal.throwIfAborted();
    }
  },
);
