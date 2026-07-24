import { isLimitedFree1RestrictedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { and, eq, gt, lte, sql, sum } from "drizzle-orm";

import {
  nullableDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
} from "../../lib/db-structured-result";
import { insufficientCredits } from "../../lib/error";
import type { Db } from "../external/db";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import { resolveUsageAllowanceAvailability } from "./usage-allowance.service";

type CreditDb = Pick<Db, "$with" | "select" | "with">;

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
  const expired = params.db.$with("expired").as(
    params.db
      .select({
        total: sql`COALESCE(${sum(creditExpiresRecord.remaining)}, 0)::bigint`
          .mapWith(pgInt8ToSafeIntegerDecoder)
          .as("total"),
      })
      .from(creditExpiresRecord)
      .where(
        and(
          eq(creditExpiresRecord.orgId, params.orgId),
          lte(creditExpiresRecord.expiresAt, sql`now()`),
          gt(creditExpiresRecord.remaining, sql`0`),
        ),
      ),
  );
  const rows = await params.db
    .with(expired)
    .select({
      credits: sql`${orgMetadata.credits}`.mapWith(
        nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder),
      ),
      unsettledExpired: expired.total,
    })
    .from(expired)
    .leftJoin(orgMetadata, eq(orgMetadata.orgId, params.orgId));

  const row = rows[0];
  if (!row || row.credits === null) {
    return null;
  }

  const credits = row.credits;
  const spendableCredits = credits - row.unsettledExpired;
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
