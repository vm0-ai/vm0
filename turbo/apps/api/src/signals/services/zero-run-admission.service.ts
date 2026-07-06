import { sql } from "drizzle-orm";
import { isLimitedFree1RestrictedRunModel } from "@vm0/api-contracts/contracts/model-providers";

import { insufficientCredits } from "../../lib/error";
import type { Db } from "../external/db";

type CreditDb = Pick<Db, "execute">;

interface CreditCheckRow extends Record<string, unknown> {
  readonly tier: string | null;
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

interface OrgCreditAvailability {
  readonly tier: string;
  readonly spendableCredits: number;
}

function allowsLimitedFree1ModelProvider(
  modelProviderType: string | null | undefined,
): boolean {
  return modelProviderType === "vm0";
}

export async function resolveOrgCreditAvailability(params: {
  readonly db: CreditDb;
  readonly orgId: string;
}): Promise<OrgCreditAvailability | null> {
  const { rows } = await params.db.execute<CreditCheckRow>(sql`
    WITH org AS (
      SELECT tier, credits FROM org_metadata
      WHERE org_id = ${params.orgId}
      LIMIT 1
    ),
    expired AS (
      SELECT COALESCE(SUM(remaining), 0)::bigint AS total
      FROM credit_expires_record
      WHERE org_id = ${params.orgId}
        AND expires_at <= now()
        AND remaining > 0
    )
    SELECT
      (SELECT tier FROM org) AS tier,
      (SELECT credits FROM org) AS credits,
      (SELECT total FROM expired) AS unsettled_expired
  `);

  const row = rows[0];
  if (!row || row.credits === null) {
    return null;
  }

  const credits = Number(row.credits);
  const unsettledExpired = Number(row.unsettled_expired ?? 0);
  const spendableCredits = credits - unsettledExpired;
  return {
    tier: row.tier ?? "pro-suspend",
    spendableCredits,
  };
}

export async function checkOrgCreditsForRunAdmission(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel?: string | null;
}): Promise<ReturnType<typeof insufficientCredits> | undefined> {
  const availability = await resolveOrgCreditAvailability(params);
  if (!availability) {
    return insufficientCredits();
  }
  if (
    availability.tier === "limited-free-1" &&
    (!allowsLimitedFree1ModelProvider(params.modelProviderType) ||
      isLimitedFree1RestrictedRunModel(params.selectedModel))
  ) {
    return insufficientCredits();
  }
  if (availability.tier === "pro-suspend") {
    return insufficientCredits();
  }

  if (params.modelProviderType !== "vm0") {
    return undefined;
  }

  return availability.spendableCredits > 0 ? undefined : insufficientCredits();
}

export async function checkLimitedFreeRunModelAdmission(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel: string | null | undefined;
}): Promise<ReturnType<typeof insufficientCredits> | undefined> {
  if (
    allowsLimitedFree1ModelProvider(params.modelProviderType) &&
    !isLimitedFree1RestrictedRunModel(params.selectedModel)
  ) {
    return undefined;
  }
  const availability = await resolveOrgCreditAvailability(params);
  return availability?.tier === "limited-free-1"
    ? insufficientCredits()
    : undefined;
}
