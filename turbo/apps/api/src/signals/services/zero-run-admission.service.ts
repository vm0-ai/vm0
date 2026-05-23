import { sql } from "drizzle-orm";

import { insufficientCredits } from "../../lib/error";
import type { Db } from "../external/db";

type CreditDb = Pick<Db, "execute">;

interface CreditCheckRow extends Record<string, unknown> {
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

interface OrgCreditAvailability {
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
  return spendableCredits > 0 ? { spendableCredits } : null;
}

export async function checkOrgCreditsForRunAdmission(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly modelProviderType: string | null | undefined;
}): Promise<ReturnType<typeof insufficientCredits> | undefined> {
  if (params.modelProviderType !== "vm0") {
    return undefined;
  }

  const availability = await resolveOrgCreditAvailability(params);
  return availability ? undefined : insufficientCredits();
}
