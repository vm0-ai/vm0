import { and, eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { redemptionCodes } from "../../db/schema/redemption-codes";
import { creditExpiresRecord } from "../../db/schema/credit-expires-record";

interface RedemptionCodeRow {
  code: string;
  creditsPerCode: number;
  createdByOrgId: string;
  createdByUserId: string;
  redeemedAt: Date | null;
  redeemedByOrgId: string | null;
  redeemedByUserId: string | null;
}

/**
 * Read a single redemption_codes row by code.
 */
export async function getRedemptionCode(
  code: string,
): Promise<RedemptionCodeRow | null> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      code: redemptionCodes.code,
      creditsPerCode: redemptionCodes.creditsPerCode,
      createdByOrgId: redemptionCodes.createdByOrgId,
      createdByUserId: redemptionCodes.createdByUserId,
      redeemedAt: redemptionCodes.redeemedAt,
      redeemedByOrgId: redemptionCodes.redeemedByOrgId,
      redeemedByUserId: redemptionCodes.redeemedByUserId,
    })
    .from(redemptionCodes)
    .where(eq(redemptionCodes.code, code));
  return row ?? null;
}

/**
 * List all redemption codes created by a specific user (ordered by code).
 */
export async function listRedemptionCodesByCreator(
  userId: string,
): Promise<RedemptionCodeRow[]> {
  initServices();
  return globalThis.services.db
    .select({
      code: redemptionCodes.code,
      creditsPerCode: redemptionCodes.creditsPerCode,
      createdByOrgId: redemptionCodes.createdByOrgId,
      createdByUserId: redemptionCodes.createdByUserId,
      redeemedAt: redemptionCodes.redeemedAt,
      redeemedByOrgId: redemptionCodes.redeemedByOrgId,
      redeemedByUserId: redemptionCodes.redeemedByUserId,
    })
    .from(redemptionCodes)
    .where(eq(redemptionCodes.createdByUserId, userId));
}

/**
 * Read the credit_expires_record row that a redemption created (if any).
 */
export async function getRedemptionExpiresRecord(
  orgId: string,
  code: string,
): Promise<{
  source: string;
  amount: number;
  remaining: number;
} | null> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      source: creditExpiresRecord.source,
      amount: creditExpiresRecord.amount,
      remaining: creditExpiresRecord.remaining,
    })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        eq(creditExpiresRecord.stripeInvoiceId, `redemption:${code}`),
      ),
    );
  return row ?? null;
}
