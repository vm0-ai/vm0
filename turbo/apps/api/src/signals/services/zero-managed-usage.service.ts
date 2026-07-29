import { randomUUID } from "node:crypto";

import { agentRuns } from "@vm0/db/schema/agent-run";
import { browserSessions } from "@vm0/db/schema/browser-session";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { command } from "ccstate";
import { and, eq, gt, inArray, lte, sql, sum } from "drizzle-orm";

import {
  nullableDriverValueDecoder,
  pgInt8ToBigIntDecoder,
} from "../../lib/db-structured-result";
import { writeDb$, type Db } from "../external/db";
import {
  lockUsageAllowanceOrg,
  resolveUsageAllowanceAvailability,
  resolveUsageAllowanceAvailabilityForLockedOrg,
} from "./usage-allowance.service";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";

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

type ManagedUsageTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

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

export async function checkCreditAmountForLockedOrg(
  writeDb: ManagedUsageTransaction,
  args: {
    readonly orgId: string;
    readonly requiredCredits: number;
  },
  signal: AbortSignal,
): Promise<ManagedUsageErrorResponse | null> {
  if (
    !Number.isSafeInteger(args.requiredCredits) ||
    args.requiredCredits <= 0
  ) {
    throw new Error("Required credits must be a positive safe integer");
  }

  const expired = writeDb.$with("expired").as(
    writeDb
      .select({
        total: sql`COALESCE(${sum(creditExpiresRecord.remaining)}, 0)::bigint`
          .mapWith(pgInt8ToBigIntDecoder)
          .as("expired_total"),
      })
      .from(creditExpiresRecord)
      .where(
        and(
          eq(creditExpiresRecord.orgId, args.orgId),
          lte(creditExpiresRecord.expiresAt, sql`now()`),
          gt(creditExpiresRecord.remaining, sql`0`),
        ),
      ),
  );
  const reserved = writeDb.$with("reserved").as(
    writeDb
      .select({
        total: sql`COALESCE(${sum(
          sql`GREATEST(${browserSessions.maxCredits} - ${browserSessions.grossCredits}, 0)`,
        )}, 0)::bigint`
          .mapWith(pgInt8ToBigIntDecoder)
          .as("reserved_total"),
      })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.orgId, args.orgId),
          inArray(browserSessions.status, [
            "creating",
            "active",
            "resuming",
            "stopping",
          ]),
        ),
      ),
  );
  const rows = await writeDb
    .with(expired, reserved)
    .select({
      credits: sql`${orgMetadata.credits}`.mapWith(
        nullableDriverValueDecoder(pgInt8ToBigIntDecoder),
      ),
      unsettledExpired: expired.total,
      reservedCredits: reserved.total,
    })
    .from(expired)
    .crossJoin(reserved)
    .leftJoin(orgMetadata, eq(orgMetadata.orgId, args.orgId));
  signal.throwIfAborted();

  const row = rows[0];
  if (!row || row.credits === null) {
    return insufficientCredits();
  }

  const spendableCredits =
    row.credits - row.unsettledExpired - row.reservedCredits;
  if (spendableCredits >= BigInt(args.requiredCredits)) {
    return null;
  }

  const allowance = await resolveUsageAllowanceAvailabilityForLockedOrg(
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
}

async function checkCreditAmountInTransaction(
  writeDb: ManagedUsageTransaction,
  args: {
    readonly orgId: string;
    readonly requiredCredits: number;
  },
  signal: AbortSignal,
): Promise<ManagedUsageErrorResponse | null> {
  await lockUsageAllowanceOrg(writeDb, args.orgId);
  signal.throwIfAborted();
  return await checkCreditAmountForLockedOrg(writeDb, args, signal);
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
    const writeDb = set(writeDb$);
    return await writeDb.transaction(async (tx) => {
      return await checkCreditAmountInTransaction(tx, args, signal);
    });
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
    const expired = writeDb.$with("expired").as(
      writeDb
        .select({
          total: sql`COALESCE(${sum(creditExpiresRecord.remaining)}, 0)::bigint`
            .mapWith(pgInt8ToBigIntDecoder)
            .as("expired_total"),
        })
        .from(creditExpiresRecord)
        .where(
          and(
            eq(creditExpiresRecord.orgId, args.orgId),
            lte(creditExpiresRecord.expiresAt, sql`now()`),
            gt(creditExpiresRecord.remaining, sql`0`),
          ),
        ),
    );
    const reserved = writeDb.$with("reserved").as(
      writeDb
        .select({
          total: sql`COALESCE(${sum(
            sql`GREATEST(${browserSessions.maxCredits} - ${browserSessions.grossCredits}, 0)`,
          )}, 0)::bigint`
            .mapWith(pgInt8ToBigIntDecoder)
            .as("reserved_total"),
        })
        .from(browserSessions)
        .where(
          and(
            eq(browserSessions.orgId, args.orgId),
            inArray(browserSessions.status, [
              "creating",
              "active",
              "resuming",
              "stopping",
            ]),
          ),
        ),
    );
    const rows = await writeDb
      .with(expired, reserved)
      .select({
        credits: sql`${orgMetadata.credits}`.mapWith(
          nullableDriverValueDecoder(pgInt8ToBigIntDecoder),
        ),
        unsettledExpired: expired.total,
        reservedCredits: reserved.total,
        unitPrice: sql`${usagePricing.unitPrice}`.mapWith(
          nullableDriverValueDecoder(pgInt8ToBigIntDecoder),
        ),
        unitSize: sql`${usagePricing.unitSize}`.mapWith(
          nullableDriverValueDecoder(pgInt8ToBigIntDecoder),
        ),
      })
      .from(expired)
      .crossJoin(reserved)
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, args.orgId))
      .leftJoin(
        usagePricing,
        and(
          eq(usagePricing.kind, args.resource.kind),
          eq(usagePricing.provider, args.resource.provider),
          eq(usagePricing.category, args.resource.category),
        ),
      );
    signal.throwIfAborted();

    const row = rows[0];
    if (row?.unitPrice === null || row?.unitSize === null) {
      return pricingNotConfigured(args.label);
    }

    if (!row || row.credits === null) {
      return insufficientCredits();
    }

    const credits = row.credits;
    const quantity = args.resource.quantity ?? 1;
    const requiredCredits = estimatedCredits(
      row.unitPrice,
      row.unitSize,
      quantity,
    );
    const spendableCredits =
      credits - row.unsettledExpired - row.reservedCredits;
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
