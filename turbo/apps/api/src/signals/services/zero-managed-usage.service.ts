import { randomUUID } from "node:crypto";

import { agentRuns } from "@vm0/db/schema/agent-run";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { executeRawRows, pgInt8ToBigIntSchema } from "../../lib/db-raw-rows";
import { writeDb$ } from "../external/db";
import { resolveUsageAllowanceAvailability } from "./usage-allowance.service";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";

const creditCheckRowSchema = z.object({
  credits: pgInt8ToBigIntSchema.nullable(),
  unsettled_expired: pgInt8ToBigIntSchema.nullable(),
  reserved_credits: pgInt8ToBigIntSchema.nullable(),
  unit_price: pgInt8ToBigIntSchema.nullable(),
  unit_size: pgInt8ToBigIntSchema.nullable(),
});

const creditAmountCheckRowSchema = creditCheckRowSchema.pick({
  credits: true,
  unsettled_expired: true,
  reserved_credits: true,
});

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
  unitPrice: bigint,
  unitSize: bigint,
  quantity: number,
): bigint {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("Managed usage quantity must be a positive safe integer");
  }
  if (unitPrice < 0n || unitSize <= 0n) {
    throw new Error(
      "Managed usage pricing must be non-negative with a positive unit size",
    );
  }
  const total = BigInt(quantity) * unitPrice;
  return (total + unitSize - 1n) / unitSize;
}

export const checkCreditAmount$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly requiredCredits: number;
    },
    signal: AbortSignal,
  ): Promise<ManagedUsageErrorResponse | null> => {
    if (
      !Number.isSafeInteger(args.requiredCredits) ||
      args.requiredCredits <= 0
    ) {
      throw new Error("Required credits must be a positive safe integer");
    }

    const writeDb = set(writeDb$);
    const rows = await executeRawRows(
      writeDb,
      sql`
        WITH org AS (
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
        ),
        reserved AS (
          SELECT COALESCE(
            SUM(GREATEST(max_credits - gross_credits, 0)),
            0
          )::bigint AS total
          FROM browser_sessions
          WHERE org_id = ${args.orgId}
            AND status IN (
              'creating',
              'active',
              'resuming',
              'stopping'
            )
        )
        SELECT
          (SELECT credits FROM org) AS credits,
          (SELECT total FROM expired) AS unsettled_expired,
          (SELECT total FROM reserved) AS reserved_credits
      `,
      creditAmountCheckRowSchema,
    );
    signal.throwIfAborted();

    const row = rows[0];
    if (!row || row.credits === null) {
      return insufficientCredits();
    }

    const reservedCredits = row.reserved_credits ?? 0n;
    const spendableCredits =
      row.credits - (row.unsettled_expired ?? 0n) - reservedCredits;
    if (spendableCredits >= BigInt(args.requiredCredits)) {
      return null;
    }

    const allowance = await resolveUsageAllowanceAvailability(
      writeDb,
      args.orgId,
    );
    signal.throwIfAborted();
    const spendableUnits =
      (spendableCredits > 0n ? spendableCredits : 0n) +
      BigInt(allowance?.remainingUnits ?? 0) -
      (spendableCredits < 0n ? -spendableCredits : 0n);
    return spendableUnits >= BigInt(args.requiredCredits)
      ? null
      : insufficientCredits();
  },
);

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
    const rows = await executeRawRows(
      writeDb,
      sql`
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
        ),
        reserved AS (
          SELECT COALESCE(
            SUM(GREATEST(max_credits - gross_credits, 0)),
            0
          )::bigint AS total
          FROM browser_sessions
          WHERE org_id = ${args.orgId}
            AND status IN (
              'creating',
              'active',
              'resuming',
              'stopping'
            )
        )
        SELECT
          (SELECT credits FROM org) AS credits,
          (SELECT total FROM expired) AS unsettled_expired,
          (SELECT total FROM reserved) AS reserved_credits,
          (SELECT unit_price FROM pricing) AS unit_price,
          (SELECT unit_size FROM pricing) AS unit_size
      `,
      creditCheckRowSchema,
    );
    signal.throwIfAborted();

    const row = rows[0];
    if (row?.unit_price === null || row?.unit_size === null) {
      return pricingNotConfigured(args.label);
    }

    if (!row || row.credits === null) {
      return insufficientCredits();
    }

    const credits = row.credits;
    const unsettledExpired = row.unsettled_expired ?? 0n;
    const reservedCredits = row.reserved_credits ?? 0n;
    const quantity = args.resource.quantity ?? 1;
    const requiredCredits = estimatedCredits(
      row.unit_price,
      row.unit_size,
      quantity,
    );
    const spendableCredits = credits - unsettledExpired - reservedCredits;
    if (spendableCredits >= requiredCredits) {
      return null;
    }

    const allowance = await resolveUsageAllowanceAvailability(
      writeDb,
      args.orgId,
    );
    signal.throwIfAborted();
    const spendableUnits =
      (spendableCredits > 0n ? spendableCredits : 0n) +
      BigInt(allowance?.remainingUnits ?? 0) -
      (spendableCredits < 0n ? -spendableCredits : 0n);
    return spendableUnits >= requiredCredits ? null : insufficientCredits();
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
    signal: AbortSignal,
  ): Promise<number> => {
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
      .select({
        billingError: usageEvent.billingError,
        creditsCharged: usageEvent.creditsCharged,
      })
      .from(usageEvent)
      .where(eq(usageEvent.id, inserted.id));
    signal.throwIfAborted();
    if (!processed || processed.creditsCharged === null) {
      throw new Error(`Failed to process ${args.label} usage event`);
    }
    if (processed.billingError !== null) {
      throw new Error(
        `Failed to bill ${args.label} usage event: ${processed.billingError}`,
      );
    }
    return processed.creditsCharged;
  },
);
