import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Db } from "../external/db";

const L = logger("onboarding-credit-grants.service");

export const LIMITED_FREE_ONBOARDING_CREDITS = 3000;

const ONBOARDING_CREDIT_SOURCE = "onboarding";
const ONBOARDING_CREDIT_IDEMPOTENCY_KEY = "limited-free-onboarding";
const ONBOARDING_CREDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function onboardingCreditsExpiresAt(grantedAt: Date): Date {
  return new Date(grantedAt.getTime() + ONBOARDING_CREDIT_TTL_MS);
}

async function grantOrgCredits(
  tx: DbTransaction,
  orgId: string,
  amount: number,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO org_metadata (org_id, credits, created_at, updated_at)
        VALUES (${orgId}, ${amount}, now(), now())
        ON CONFLICT (org_id)
        DO UPDATE SET credits = org_metadata.credits + ${amount}, updated_at = now()`,
  );
}

export async function grantOnboardingCredits(
  tx: DbTransaction,
  orgId: string,
  amount: number,
  expiresAt: Date,
): Promise<void> {
  const rows = await tx
    .insert(creditExpiresRecord)
    .values({
      orgId,
      source: ONBOARDING_CREDIT_SOURCE,
      stripeInvoiceId: ONBOARDING_CREDIT_IDEMPOTENCY_KEY,
      amount,
      remaining: amount,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: creditExpiresRecord.id });

  if (rows.length === 0) {
    L.debug("Onboarding credits already granted", { orgId });
    return;
  }

  await grantOrgCredits(tx, orgId, amount);
}
