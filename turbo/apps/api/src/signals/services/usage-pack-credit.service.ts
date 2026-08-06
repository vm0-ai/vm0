import { usagePackCreditGrants } from "@vm0/db/schema/usage-pack-credit-grant";
import { and, eq, gt, sql, sum } from "drizzle-orm";

import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { settle } from "../utils";

const PG_UNDEFINED_TABLE = "42P01";

interface UsagePackCreditGrantArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly grantType: "purchased" | "bonus";
  readonly idempotencyKey: string;
  readonly amount: number;
  readonly expiresAt: Date;
}

interface UsagePackCreditGrantResult {
  readonly id: string;
  readonly created: boolean;
}

export function isUsagePackCreditGrantTableUnavailable(
  error: unknown,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const { cause } = error;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === PG_UNDEFINED_TABLE
  );
}

export async function createUsagePackCreditGrant(
  db: Db,
  args: UsagePackCreditGrantArgs,
): Promise<UsagePackCreditGrantResult> {
  // Fulfillment is intentionally independent of the enrollment feature switch:
  // an already-paid subscription must still be safe to fulfill after rollout closes.
  const [inserted] = await db
    .insert(usagePackCreditGrants)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      grantType: args.grantType,
      idempotencyKey: args.idempotencyKey,
      originalAmount: args.amount,
      remainingAmount: args.amount,
      expiresAt: args.expiresAt,
    })
    .onConflictDoNothing({ target: usagePackCreditGrants.idempotencyKey })
    .returning({ id: usagePackCreditGrants.id });
  if (inserted) {
    return { id: inserted.id, created: true };
  }

  const [existing] = await db
    .select({
      id: usagePackCreditGrants.id,
      orgId: usagePackCreditGrants.orgId,
      userId: usagePackCreditGrants.userId,
      grantType: usagePackCreditGrants.grantType,
      originalAmount: usagePackCreditGrants.originalAmount,
      expiresAt: usagePackCreditGrants.expiresAt,
    })
    .from(usagePackCreditGrants)
    .where(eq(usagePackCreditGrants.idempotencyKey, args.idempotencyKey))
    .limit(1);
  if (
    !existing ||
    existing.orgId !== args.orgId ||
    existing.userId !== args.userId ||
    existing.grantType !== args.grantType ||
    existing.originalAmount !== args.amount ||
    existing.expiresAt.getTime() !== args.expiresAt.getTime()
  ) {
    throw new Error("Usage pack credit grant idempotency key conflict");
  }
  return { id: existing.id, created: false };
}

export async function getSpendableUsagePackCredits(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly at?: Date;
  },
): Promise<number> {
  const result = await settle(
    db
      .select({
        total:
          sql`COALESCE(${sum(usagePackCreditGrants.remainingAmount)}, 0)::bigint`
            .mapWith(pgInt8ToSafeIntegerDecoder)
            .as("total"),
      })
      .from(usagePackCreditGrants)
      .where(
        and(
          eq(usagePackCreditGrants.orgId, args.orgId),
          eq(usagePackCreditGrants.userId, args.userId),
          gt(usagePackCreditGrants.remainingAmount, 0),
          gt(usagePackCreditGrants.expiresAt, args.at ?? nowDate()),
        ),
      ),
  );
  if (!result.ok) {
    // Migration 0841 runs before API promotion, but rollback and isolated
    // probes can briefly execute this reader without the table. Remove after
    // 0841 is present in every supported API rollback database.
    if (isUsagePackCreditGrantTableUnavailable(result.error)) {
      return 0;
    }
    throw result.error;
  }
  return result.value[0]?.total ?? 0;
}
