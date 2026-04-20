/**
 * Redemption Code Service
 *
 * Mint and redeem one-time codes that grant credits to the redeeming org.
 * Authorization (staff-only mint) is enforced at the API route; this module
 * only deals with persistence and the atomic single-use guarantee.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { redemptionCodes } from "../../../db/schema/redemption-codes";
import { orgMetadata } from "../../../db/schema/org-metadata";
import { generateCode } from "../../shared/crypto/generate-code";
import { badRequest } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { grantOrgCredits } from "../org/org-service";
import { createExpiresRecord } from "./credit-expires-service";

const log = logger("service:redemption-code");

/** 1-year default validity for both the code itself and the granted credits. */
const REDEMPTION_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

/** Maximum number of distinct codes we'll try when hitting PK collisions. */
const MAX_COLLISION_RETRIES = 5;

interface MintRedemptionCodesOptions {
  orgId: string;
  userId: string;
  creditsPerCode: number;
  quantity: number;
}

interface MintedRedemptionCode {
  code: string;
  creditsPerCode: number;
  expiresAt: Date;
}

/**
 * Mint `quantity` codes, each worth `creditsPerCode`. Codes are random
 * `XXXX-XXXX` strings; PK collisions retry up to `MAX_COLLISION_RETRIES`.
 * All inserts happen inside a single transaction — if any code repeatedly
 * collides, the transaction aborts and no codes are persisted.
 */
export async function mintRedemptionCodes(
  opts: MintRedemptionCodesOptions,
): Promise<MintedRedemptionCode[]> {
  const { orgId, userId, creditsPerCode, quantity } = opts;
  const db = globalThis.services.db;
  const expiresAt = new Date(Date.now() + REDEMPTION_VALIDITY_MS);

  const minted: MintedRedemptionCode[] = [];

  await db.transaction(async (tx) => {
    for (let i = 0; i < quantity; i++) {
      let inserted = false;
      for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
        const code = generateCode();
        const rows = await tx
          .insert(redemptionCodes)
          .values({
            code,
            creditsPerCode,
            createdByOrgId: orgId,
            createdByUserId: userId,
            expiresAt,
          })
          .onConflictDoNothing()
          .returning({ code: redemptionCodes.code });
        if (rows.length > 0) {
          minted.push({ code, creditsPerCode, expiresAt });
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        throw new Error(
          "Failed to generate a unique redemption code after retries",
        );
      }
    }
  });

  log.info("redemption codes minted", {
    orgId,
    userId,
    quantity: minted.length,
    creditsPerCode,
  });
  return minted;
}

interface RedeemRedemptionCodeOptions {
  orgId: string;
  userId: string;
  code: string;
}

interface RedeemRedemptionCodeResult {
  credits: number;
  newBalance: number;
}

/**
 * Redeem a code for credits. Single-use is enforced by the partial-match
 * UPDATE (only matches unredeemed, unexpired rows) — PostgreSQL guarantees
 * exactly one concurrent call returns a row. On success, grants credits and
 * inserts an expiration record tagged `source: "redemption"`.
 */
export async function redeemRedemptionCode(
  opts: RedeemRedemptionCodeOptions,
): Promise<RedeemRedemptionCodeResult> {
  const normalizedCode = opts.code.trim().toUpperCase();
  if (!normalizedCode) {
    throw badRequest("Redemption code is required");
  }

  const db = globalThis.services.db;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REDEMPTION_VALIDITY_MS);

  const result = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(redemptionCodes)
      .set({
        redeemedAt: now,
        redeemedByOrgId: opts.orgId,
        redeemedByUserId: opts.userId,
      })
      .where(
        and(
          eq(redemptionCodes.code, normalizedCode),
          isNull(redemptionCodes.redeemedAt),
          gt(redemptionCodes.expiresAt, now),
        ),
      )
      .returning({ creditsPerCode: redemptionCodes.creditsPerCode });

    const row = claimed[0];
    if (!row) {
      throw badRequest("Code is invalid, already redeemed, or expired");
    }

    await grantOrgCredits(tx, opts.orgId, row.creditsPerCode);
    await createExpiresRecord(tx, opts.orgId, {
      source: "redemption",
      stripeInvoiceId: `redemption:${normalizedCode}`,
      amount: row.creditsPerCode,
      expiresAt,
    });

    const [balance] = await tx
      .select({ credits: orgMetadata.credits })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, opts.orgId));

    return {
      credits: row.creditsPerCode,
      newBalance: balance?.credits ?? row.creditsPerCode,
    };
  });

  log.info("redemption code redeemed", {
    orgId: opts.orgId,
    userId: opts.userId,
    code: normalizedCode,
    credits: result.credits,
  });

  return result;
}
