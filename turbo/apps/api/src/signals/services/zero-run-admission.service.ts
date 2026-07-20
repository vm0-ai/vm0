import { sql } from "drizzle-orm";
import { isLimitedFree1RestrictedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import { z } from "zod";

import {
  executeRawRows,
  pgInt8ToSafeIntegerSchema,
} from "../../lib/db-raw-rows";
import { insufficientCredits } from "../../lib/error";
import type { Db } from "../external/db";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import { resolveUsageAllowanceAvailability } from "./usage-allowance.service";

type CreditDb = Pick<Db, "execute" | "select">;

const creditCheckRowSchema = z.object({
  credits: pgInt8ToSafeIntegerSchema.nullable(),
  unsettled_expired: pgInt8ToSafeIntegerSchema.nullable(),
});

interface OrgCreditAvailability {
  readonly status: OrgPlanCapabilities["status"];
  readonly supportByok: boolean;
  readonly restrictedVm0Models: boolean;
  readonly spendableCredits: number;
}

type OrgPlanRunAdmissionCapabilities = Pick<
  OrgPlanCapabilities,
  "status" | "supportByok" | "restrictedVm0Models"
>;

export async function resolveOrgCreditAvailability(params: {
  readonly db: CreditDb;
  readonly orgId: string;
}): Promise<OrgCreditAvailability | null> {
  const rows = await executeRawRows(
    params.db,
    sql`
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
    `,
    creditCheckRowSchema,
  );

  const row = rows[0];
  if (!row || row.credits === null) {
    return null;
  }

  const credits = row.credits;
  const unsettledExpired = row.unsettled_expired ?? 0;
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
  return await checkResolvedOrgCreditsForRunAdmission({
    ...params,
    availability,
  });
}

export async function checkResolvedOrgCreditsForRunAdmission(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel?: string | null;
  readonly availability: OrgCreditAvailability | null;
}): Promise<ReturnType<typeof insufficientCredits> | undefined> {
  const { availability } = params;
  if (!availability) {
    return insufficientCredits();
  }
  const planAdmission = checkOrgPlanRunAdmission({
    capabilities: availability,
    modelProviderType: params.modelProviderType,
    selectedModel: params.selectedModel,
  });
  if (planAdmission) {
    return planAdmission;
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

export function checkOrgPlanRunAdmission(params: {
  readonly capabilities: OrgPlanRunAdmissionCapabilities | null;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel: string | null | undefined;
}): ReturnType<typeof insufficientCredits> | undefined {
  const { capabilities } = params;
  if (!capabilities || capabilities.status !== "active") {
    return insufficientCredits();
  }
  return (!capabilities.supportByok && params.modelProviderType !== "vm0") ||
    (capabilities.restrictedVm0Models &&
      isLimitedFree1RestrictedRunModel(params.selectedModel))
    ? insufficientCredits()
    : undefined;
}
