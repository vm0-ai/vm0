import { command } from "ccstate";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { logger } from "../../lib/log";
import { usageUnderbillingFields } from "../usage-underbilling";
import { tapError } from "../utils";
import { maybeEmitRunUsageMessage$ } from "./zero-chat-usage-message.service";
import {
  enqueueCreditLowBalanceAlert$,
  LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS,
  type CreditLowBalanceAlertArgs,
} from "./zero-credit-low-balance-alert.service";
import { triggerAutoRecharge$ } from "./zero-credit-recharge.service";
import { applyUsageAllowanceToUsageEventsInLockedTransaction } from "./usage-allowance.service";

const L = logger("CreditUsage");

type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function deductOrgCredits(
  tx: WriteTx,
  orgId: string,
  amount: number,
): Promise<void> {
  await tx
    .insert(orgMetadata)
    .values({
      orgId,
      credits: -amount,
      createdAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: {
        credits: sql`${orgMetadata.credits} - ${amount}`,
        updatedAt: sql`now()`,
      },
    });
}

async function getOrgCredits(tx: WriteTx, orgId: string): Promise<number> {
  const [metadata] = await tx
    .select({ credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return metadata?.credits ?? 0;
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

interface ProcessOrgUsageEventsResult {
  readonly billableCredits: number;
  readonly runIds: readonly string[];
  readonly lowBalanceAlert: CreditLowBalanceAlertArgs | null;
}

type UsageEventRecord = typeof usageEvent.$inferSelect;
type UsagePricingRecord = typeof usagePricing.$inferSelect;
type UsageEventBillingError = "missing_pricing" | "fallback_pricing" | null;

interface PricedUsageEvent {
  readonly record: UsageEventRecord;
  readonly grossCredits: number;
  readonly billingError: UsageEventBillingError;
}

function priceUsageEvents(
  records: readonly UsageEventRecord[],
  pricingRecords: readonly UsagePricingRecord[],
  orgId: string,
): PricedUsageEvent[] {
  const pricingByKey = new Map(
    pricingRecords.map((pricing) => {
      return [
        `${pricing.kind}|${pricing.provider}|${pricing.category}`,
        pricing,
      ];
    }),
  );
  const pricedEvents: PricedUsageEvent[] = [];
  for (const record of records) {
    if (record.kind === "model" && record.grossCredits !== null) {
      pricedEvents.push({
        record,
        grossCredits: record.grossCredits,
        billingError: null,
      });
      continue;
    }
    const exactPricing = pricingByKey.get(
      `${record.kind}|${record.provider}|${record.category}`,
    );
    const pricing =
      exactPricing ??
      pricingByKey.get(`${record.kind}|${record.provider}|__fallback__`);

    if (!pricing) {
      L.error("Missing usage_pricing — charged zero", {
        ...usageUnderbillingFields("missing_pricing", "confirmed"),
        orgId,
        runId: record.runId,
        idempotencyKey: record.idempotencyKey,
        userId: record.userId,
        kind: record.kind,
        provider: record.provider,
        category: record.category,
        quantity: record.quantity,
      });
      pricedEvents.push({
        record,
        grossCredits: 0,
        billingError: "missing_pricing",
      });
      continue;
    }

    if (!exactPricing) {
      L.error("Missing usage_pricing — billed at fallback rate", {
        ...usageUnderbillingFields("fallback_pricing", "confirmed"),
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

    pricedEvents.push({
      record,
      grossCredits: Math.ceil(
        (record.quantity * pricing.unitPrice) / pricing.unitSize,
      ),
      billingError: exactPricing ? null : "fallback_pricing",
    });
  }
  return pricedEvents;
}

interface UsageEventSettlementOutcome {
  readonly usageEventId: string;
  readonly creditsCharged: number;
  readonly billingError: UsageEventBillingError;
}

async function markUsageEventsProcessed(
  tx: WriteTx,
  outcomes: readonly UsageEventSettlementOutcome[],
): Promise<void> {
  if (outcomes.length === 0) {
    return;
  }

  const usageEventIds = outcomes.map((outcome) => {
    return outcome.usageEventId;
  });
  const creditsCharged = outcomes.map((outcome) => {
    return outcome.creditsCharged;
  });
  const billingErrors = outcomes.map((outcome) => {
    return outcome.billingError;
  });
  const settlementSource = sql`
    unnest(
      ${sql.param(usageEventIds)}::uuid[],
      ${sql.param(creditsCharged)}::bigint[],
      ${sql.param(billingErrors)}::varchar(50)[]
    ) AS settlement(usage_event_id, credits_charged, billing_error)
  `;
  await tx
    .update(usageEvent)
    .set({
      creditsCharged: sql`settlement.credits_charged`,
      status: "processed",
      processedAt: nowDate(),
      billingError: sql`settlement.billing_error`,
    })
    .from(settlementSource)
    .where(eq(usageEvent.id, sql`settlement.usage_event_id`));
}

async function processOrgUsageEventsInTransaction(
  tx: WriteTx,
  orgId: string,
  signal: AbortSignal,
): Promise<ProcessOrgUsageEventsResult> {
  // Same advisory key as web: 'credit_' prefix + orgId.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('credit_' || ${orgId}))`,
  );

  const pendingRecords = await tx
    .select()
    .from(usageEvent)
    .where(and(eq(usageEvent.orgId, orgId), eq(usageEvent.status, "pending")));

  if (pendingRecords.length === 0) {
    return {
      billableCredits: 0,
      runIds: [],
      lowBalanceAlert: null,
    };
  }
  const runIds = [
    ...new Set(
      pendingRecords.flatMap((record) => {
        return record.runId ? [record.runId] : [];
      }),
    ),
  ];

  const pricingRecords = pendingRecords.some((record) => {
    return record.grossCredits === null;
  })
    ? await tx.select().from(usagePricing)
    : [];
  const pricedEvents = priceUsageEvents(pendingRecords, pricingRecords, orgId);

  const allowanceByUsageEvent =
    await applyUsageAllowanceToUsageEventsInLockedTransaction(tx, {
      orgId,
      events: pricedEvents.map((event) => {
        return {
          usageEventId: event.record.id,
          runId: event.record.runId,
          grossUnits: event.grossCredits,
          occurredAt: event.record.createdAt,
        };
      }),
    });
  let billableCredits = 0;
  const settlementOutcomes = pricedEvents.map((event) => {
    const allowanceUnits = allowanceByUsageEvent.get(event.record.id) ?? 0;
    const creditsCharged = event.grossCredits - allowanceUnits;
    billableCredits += creditsCharged;
    return {
      usageEventId: event.record.id,
      creditsCharged,
      billingError: event.billingError,
    };
  });
  await markUsageEventsProcessed(tx, settlementOutcomes);
  signal.throwIfAborted();

  let lowBalanceAlert: CreditLowBalanceAlertArgs | null = null;
  if (billableCredits > 0) {
    // Order matters: settle expired credits BEFORE the new deduction.
    const beforeCredits = await getOrgCredits(tx, orgId);
    const totalExpired = await expireCredits(tx, orgId);
    const effectiveBeforeCredits = Math.max(beforeCredits - totalExpired, 0);
    await deductOrgCredits(tx, orgId, billableCredits);
    const afterCredits = await getOrgCredits(tx, orgId);
    await deductFromExpiresRecords(tx, orgId, billableCredits);
    if (
      effectiveBeforeCredits > LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS &&
      afterCredits <= LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS
    ) {
      lowBalanceAlert = {
        orgId,
        remainingCredits: afterCredits,
        thresholdCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS,
      };
    }
  }
  signal.throwIfAborted();
  return { billableCredits, runIds, lowBalanceAlert };
}

/**
 * Atomically process pending usage_event records for an org and deduct
 * the allowance-uncovered total from the org's credit balance.
 *
 * Mirrors apps/web's `processOrgUsageEvents`. The transactional invariant
 * is critical: events are marked processed IFF the credit deduction
 * succeeds. If any helper throws, the whole transaction rolls back.
 *
 * Acquires `pg_advisory_xact_lock(hashtext('credit_' || orgId))` —
 * verbatim same key string as web so api and web serialize correctly on
 * the same org during rollout.
 *
 * After the transaction commits and credits are deducted, runs post-billing
 * side effects outside the credit transaction:
 * - `triggerAutoRecharge$` for Stripe top-up when the balance crosses the
 *   recharge threshold.
 * - `enqueueCreditLowBalanceAlert$` when usage crosses the low-credit email
 *   threshold.
 *
 * Both side effects are bounded by the route handler's outer waitUntil
 * envelope. Low-balance alert failures are logged without affecting billing.
 */
export const processOrgUsageEvents$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);

    const { billableCredits, runIds, lowBalanceAlert } =
      await writeDb.transaction((tx) => {
        return processOrgUsageEventsInTransaction(tx, orgId, signal);
      });
    signal.throwIfAborted();

    if (billableCredits > 0) {
      // Auto-recharge runs OUTSIDE the deduction transaction (Stripe
      // can't be transactional with DB). triggerAutoRecharge$ catches
      // its own errors (clearPendingFlag in catch); the await here is
      // bounded by the route handler's outer waitUntil envelope.
      await set(triggerAutoRecharge$, orgId, signal);
      signal.throwIfAborted();
    }

    if (lowBalanceAlert) {
      await tapError(
        set(enqueueCreditLowBalanceAlert$, lowBalanceAlert, signal),
        (error) => {
          L.error("Failed to enqueue low-credit alert after usage processing", {
            orgId,
            error,
          });
        },
      );
      signal.throwIfAborted();
    }

    for (const runId of runIds) {
      await tapError(set(maybeEmitRunUsageMessage$, runId, signal), (error) => {
        L.error("Failed to emit chat usage message after usage processing", {
          orgId,
          runId,
          error,
        });
      });
      signal.throwIfAborted();
    }
  },
);
