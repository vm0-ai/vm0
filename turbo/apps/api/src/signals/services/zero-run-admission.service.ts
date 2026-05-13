import { sql } from "drizzle-orm";

import { insufficientCredits } from "../../lib/error";
import type { Db } from "../external/db";

interface CreditCheckRow extends Record<string, unknown> {
  readonly credit_enabled: boolean | null;
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

export async function checkOrgCreditsForRunAdmission(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderType: string | null | undefined;
}): Promise<ReturnType<typeof insufficientCredits> | undefined> {
  if (params.modelProviderType !== "vm0") {
    return undefined;
  }

  const { rows } = await params.db.execute<CreditCheckRow>(sql`
    WITH member AS (
      SELECT credit_enabled FROM org_members_metadata
      WHERE org_id = ${params.orgId} AND user_id = ${params.userId}
      LIMIT 1
    ),
    org AS (
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
      (SELECT credit_enabled FROM member) AS credit_enabled,
      (SELECT credits FROM org) AS credits,
      (SELECT total FROM expired) AS unsettled_expired
  `);

  const row = rows[0];
  if (!row || row.credit_enabled === false || row.credits === null) {
    return insufficientCredits();
  }

  const credits = Number(row.credits);
  const unsettledExpired = Number(row.unsettled_expired ?? 0);
  return credits - unsettledExpired > 0 ? undefined : insufficientCredits();
}
