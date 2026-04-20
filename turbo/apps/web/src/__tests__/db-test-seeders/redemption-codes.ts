import { initServices } from "../../lib/init-services";
import { redemptionCodes } from "../../db/schema/redemption-codes";

/**
 * Seed a redemption code row for redemption tests.
 *
 * @why-db-direct Redemption codes are normally minted by the staff-only API,
 * but redeem-path tests need to pre-populate codes without going through
 * the mint authorization check — we're specifically testing the redeem
 * endpoint's behavior, not the mint flow.
 */
export async function seedRedemptionCode(opts: {
  code: string;
  creditsPerCode: number;
  expiresAt?: Date;
  createdByOrgId?: string;
  createdByUserId?: string;
  redeemedByOrgId?: string;
  redeemedByUserId?: string;
  redeemedAt?: Date;
}): Promise<void> {
  initServices();
  await globalThis.services.db.insert(redemptionCodes).values({
    code: opts.code,
    creditsPerCode: opts.creditsPerCode,
    createdByOrgId: opts.createdByOrgId ?? "org_creator",
    createdByUserId: opts.createdByUserId ?? "user_creator",
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000),
    redeemedByOrgId: opts.redeemedByOrgId,
    redeemedByUserId: opts.redeemedByUserId,
    redeemedAt: opts.redeemedAt,
  });
}
