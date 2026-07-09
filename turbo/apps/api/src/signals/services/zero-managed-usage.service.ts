import { randomUUID } from "node:crypto";

import { agentRuns } from "@vm0/db/schema/agent-run";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";

interface CreditCheckRow extends Record<string, unknown> {
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
  readonly unit_price: string | null;
  readonly unit_size: string | null;
}

export interface ManagedUsageErrorResponse {
  readonly status: 402 | 503;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface ManagedUsageResource {
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
  readonly quantity?: number;
}

interface ManagedUsageActor {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
}

// Usage commit work runs after a managed provider has completed paid work, so
// client request cancellation must not skip the billing record.
export const MANAGED_USAGE_COMMIT_SIGNAL = AbortSignal.any([]);

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function insufficientCredits(): ManagedUsageErrorResponse {
  return {
    status: 402,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
}

function pricingNotConfigured(label: string): ManagedUsageErrorResponse {
  return {
    status: 503,
    body: errorBody(
      `${label} pricing is not configured`,
      "PRICING_NOT_CONFIGURED",
    ),
  };
}

function estimatedCredits(
  unitPrice: string,
  unitSize: string,
  quantity: number,
): bigint {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("Managed usage quantity must be a positive safe integer");
  }
  const price = BigInt(unitPrice);
  const size = BigInt(unitSize);
  if (price < 0n || size <= 0n) {
    throw new Error(
      "Managed usage pricing must be non-negative with a positive unit size",
    );
  }
  const total = BigInt(quantity) * price;
  return (total + size - 1n) / size;
}

export const checkManagedCredits$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly resource: ManagedUsageResource;
      readonly label: string;
    },
    signal: AbortSignal,
  ): Promise<ManagedUsageErrorResponse | null> => {
    const writeDb = set(writeDb$);
    const { rows } = await writeDb.execute<CreditCheckRow>(sql`
      WITH pricing AS (
        SELECT unit_price, unit_size FROM usage_pricing
        WHERE kind = ${args.resource.kind}
          AND provider = ${args.resource.provider}
          AND category = ${args.resource.category}
        LIMIT 1
      ),
      org AS (
        SELECT credits FROM org_metadata
        WHERE org_id = ${args.orgId}
        LIMIT 1
      ),
      expired AS (
        SELECT COALESCE(SUM(remaining), 0)::bigint AS total
        FROM credit_expires_record
        WHERE org_id = ${args.orgId}
          AND expires_at <= now()
          AND remaining > 0
      )
      SELECT
        (SELECT credits FROM org) AS credits,
        (SELECT total FROM expired) AS unsettled_expired,
        (SELECT unit_price FROM pricing) AS unit_price,
        (SELECT unit_size FROM pricing) AS unit_size
    `);
    signal.throwIfAborted();

    const row = rows[0];
    if (row?.unit_price === null || row?.unit_size === null) {
      return pricingNotConfigured(args.label);
    }

    if (!row || row.credits === null) {
      return insufficientCredits();
    }

    const credits = BigInt(row.credits);
    const unsettledExpired = BigInt(row.unsettled_expired ?? "0");
    const quantity = args.resource.quantity ?? 1;
    return credits - unsettledExpired >=
      estimatedCredits(row.unit_price, row.unit_size, quantity)
      ? null
      : insufficientCredits();
  },
);

export const recordManagedUsage$ = command(
  async (
    { set },
    args: {
      readonly actor: ManagedUsageActor;
      readonly resource: ManagedUsageResource;
      readonly label: string;
    },
    _signal: AbortSignal,
  ): Promise<number> => {
    // Provider work has already succeeded before this command is called, so
    // usage recording must not be skipped when the client disconnects.
    const signal = MANAGED_USAGE_COMMIT_SIGNAL;
    const writeDb = set(writeDb$);
    const [run] = args.actor.runId
      ? await writeDb
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, args.actor.runId),
              eq(agentRuns.orgId, args.actor.orgId),
              eq(agentRuns.userId, args.actor.userId),
            ),
          )
      : [];
    signal.throwIfAborted();

    const [inserted] = await writeDb
      .insert(usageEvent)
      .values({
        runId: run?.id ?? null,
        idempotencyKey: randomUUID(),
        orgId: args.actor.orgId,
        userId: args.actor.userId,
        kind: args.resource.kind,
        provider: args.resource.provider,
        category: args.resource.category,
        quantity: args.resource.quantity ?? 1,
      })
      .returning({ id: usageEvent.id });
    signal.throwIfAborted();

    if (!inserted) {
      throw new Error(`Failed to insert ${args.label} usage event`);
    }

    await set(processOrgUsageEvents$, args.actor.orgId, signal);
    signal.throwIfAborted();

    const [processed] = await writeDb
      .select({ creditsCharged: usageEvent.creditsCharged })
      .from(usageEvent)
      .where(eq(usageEvent.id, inserted.id));
    signal.throwIfAborted();
    if (!processed || processed.creditsCharged === null) {
      throw new Error(`Failed to process ${args.label} usage event`);
    }
    return processed.creditsCharged;
  },
);
