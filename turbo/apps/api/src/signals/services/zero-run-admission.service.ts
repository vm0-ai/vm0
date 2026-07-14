import { sql } from "drizzle-orm";
import { isLimitedFree1RestrictedRunModel } from "@vm0/api-contracts/contracts/model-providers";

import { insufficientCredits } from "../../lib/error";
import type { Db } from "../external/db";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { resolveUsageAllowanceAvailability } from "./usage-allowance.service";

type CreditDb = Pick<Db, "execute" | "select">;

interface CreditCheckRow extends Record<string, unknown> {
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

interface OrgCreditAvailability {
  readonly status: string;
  readonly supportByok: boolean;
  readonly restrictedVm0Models: boolean;
  readonly spendableCredits: number;
}

export async function resolveOrgCreditAvailability(params: {
  readonly db: CreditDb;
  readonly orgId: string;
}): Promise<OrgCreditAvailability | null> {
  const { rows } = await params.db.execute<CreditCheckRow>(sql`
    WITH org AS (
      SELECT credits FROM org_metadata
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
  const capabilities = await loadOrgPlanCapabilities(params.db, params.orgId);
  if (!capabilities) {
    return null;
  }
  return {
    status: capabilities.status,
    supportByok: capabilities.supportByok,
    restrictedVm0Models: capabilities.restrictedVm0Models,
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
    (!availability.supportByok && params.modelProviderType !== "vm0") ||
    (availability.restrictedVm0Models &&
      isLimitedFree1RestrictedRunModel(params.selectedModel))
  ) {
    return insufficientCredits();
  }
  if (availability.status !== "active") {
    return insufficientCredits();
  }

  if (params.modelProviderType !== "vm0") {
    return undefined;
  }

  if (availability.spendableCredits > 0) {
    return undefined;
  }

  const allowance = await resolveUsageAllowanceAvailability(
    params.db,
    params.orgId,
  );
  return allowance && allowance.remainingUnits > 0
    ? undefined
    : insufficientCredits();
}

export async function checkOrgModelRunAdmission(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel: string | null | undefined;
}): Promise<ReturnType<typeof insufficientCredits> | undefined> {
  const availability = await resolveOrgCreditAvailability(params);
  if (!availability) {
    return undefined;
  }
  return (!availability.supportByok && params.modelProviderType !== "vm0") ||
    (availability.restrictedVm0Models &&
      isLimitedFree1RestrictedRunModel(params.selectedModel))
    ? insufficientCredits()
    : undefined;
}
