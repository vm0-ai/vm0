/**
 * Redemption Code Service
 *
 * Mint and redeem one-time codes that grant credits to the redeeming org.
 * Authorization (staff-only mint) is enforced at the API route; this module
 * only deals with persistence and the atomic single-use guarantee.
 */
import { and, count, desc, eq, gt, gte, isNull } from "drizzle-orm";
import { redemptionCodes } from "../../../db/schema/redemption-codes";
import { redemptionCodeAttempts } from "../../../db/schema/redemption-code-attempts";
import { orgMetadata } from "../../../db/schema/org-metadata";
import { generateCode } from "../../shared/crypto/generate-code";
import { badRequest, tooManyRequests } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { grantOrgCredits } from "../org/org-service";
import { createExpiresRecord } from "./credit-expires-service";

const log = logger("service:redemption-code");

/**
 * 30-day default validity for both the code itself and the granted credits.
 * Set on mint to cap how long an unredeemed code stays usable, and re-used
 * on redeem as the expiry of the resulting credit grant. Keeping the same
 * window for both keeps accounting simple: an unredeemed code and a redeemed
 * one never outlive each other by more than 30 days, so staff don't need a
 * long-tail view of outstanding grants.
 */
const REDEMPTION_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum number of distinct codes we'll try when hitting PK collisions. */
const MAX_COLLISION_RETRIES = 5;

/**
 * Mandatory prefix for every vm0 redemption code. Serves two purposes:
 *   - user-facing recognition ("is this a vm0 code?"),
 *   - a cheap first-pass reject during redeem so bogus inputs never touch
 *     the DB and never consume per-user rate-limit budget.
 * Kept separate from the random suffix so the suffix alone still carries
 * the full entropy of `generateCode()`.
 */
const REDEMPTION_CODE_PREFIX = "VM0";

/**
 * Random-suffix length in characters. `generateCode(N)` produces
 * `N` random chars grouped by 4 and joined with "-", so 16 gives
 * "XXXX-XXXX-XXXX-XXXX" (~78 bits of entropy over a 30-char alphabet).
 */
const REDEMPTION_CODE_RANDOM_LENGTH = 16;

function formatCode(randomSuffix: string): string {
  return `${REDEMPTION_CODE_PREFIX}-${randomSuffix}`;
}

/** Short, log-safe representation of a code (keeps the prefix, masks the rest). */
function redactCode(): string {
  return `${REDEMPTION_CODE_PREFIX}-****-****-****-****`;
}

// ---------------------------------------------------------------------------
// Rate limiting (redeem-only)
// ---------------------------------------------------------------------------

/**
 * Per-user rate limit on the redeem endpoint. Keys on `user_id` — a hostile
 * caller can only spin up new users at the rate Clerk onboarding allows,
 * which is a much narrower channel than unlimited redeem attempts.
 */
const REDEEM_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const REDEEM_RATE_LIMIT_MAX_FAILURES = 10;

async function assertRedeemRateLimit(userId: string): Promise<void> {
  const db = globalThis.services.db;
  const since = new Date(Date.now() - REDEEM_RATE_LIMIT_WINDOW_MS);
  const [row] = await db
    .select({ failures: count() })
    .from(redemptionCodeAttempts)
    .where(
      and(
        eq(redemptionCodeAttempts.userId, userId),
        eq(redemptionCodeAttempts.success, false),
        gte(redemptionCodeAttempts.attemptedAt, since),
      ),
    );
  const failures = row?.failures ?? 0;
  if (failures >= REDEEM_RATE_LIMIT_MAX_FAILURES) {
    log.warn("redemption code rate limit hit", {
      userId,
      failuresInWindow: failures,
      windowMs: REDEEM_RATE_LIMIT_WINDOW_MS,
    });
    throw tooManyRequests(
      "Too many failed redemption attempts. Please wait before trying again.",
    );
  }
}

async function recordRedeemAttempt(
  userId: string,
  success: boolean,
): Promise<void> {
  const db = globalThis.services.db;
  await db.insert(redemptionCodeAttempts).values({ userId, success });
}

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
      let attemptsUsed = 0;
      for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
        attemptsUsed = attempt + 1;
        const code = formatCode(generateCode(REDEMPTION_CODE_RANDOM_LENGTH));
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
          if (attempt > 0) {
            log.warn("redemption code PK collision recovered", {
              orgId,
              userId,
              attempts: attemptsUsed,
            });
          }
          minted.push({ code, creditsPerCode, expiresAt });
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        log.error("redemption code PK collision retries exhausted", {
          orgId,
          userId,
          attempts: attemptsUsed,
          quantityRequested: quantity,
          mintedBeforeFailure: minted.length,
        });
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
  // Format gate: bogus inputs (wrong prefix) never touch the DB and never
  // consume rate-limit budget. Unified error string with the downstream path
  // so existence vs. format is not leaked.
  if (!normalizedCode.startsWith(`${REDEMPTION_CODE_PREFIX}-`)) {
    throw badRequest("Code is invalid, already redeemed, or expired");
  }

  // Rate-limit check happens before any DB write to the codes table so that
  // a throttled caller cannot observe single-use state or credit grants.
  await assertRedeemRateLimit(opts.userId);

  const db = globalThis.services.db;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REDEMPTION_VALIDITY_MS);

  let result: RedeemRedemptionCodeResult;
  try {
    result = await db.transaction(async (tx) => {
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
  } catch (err) {
    // Every failed call (bad code, already redeemed, expired) counts toward
    // the per-user rate limit budget — this is the attack surface we care about.
    // Swallow secondary accounting-write failures so the original redeem error
    // (the one the caller actually needs to see) always surfaces cleanly.
    try {
      await recordRedeemAttempt(opts.userId, false);
    } catch (recordErr) {
      log.error("failed to record redeem failure attempt", {
        userId: opts.userId,
        error:
          recordErr instanceof Error ? recordErr.message : String(recordErr),
      });
    }
    throw err;
  }

  await recordRedeemAttempt(opts.userId, true);

  log.info("redemption code redeemed", {
    orgId: opts.orgId,
    userId: opts.userId,
    code: redactCode(),
    credits: result.credits,
  });

  return result;
}

interface ListedRedemptionCode {
  code: string;
  creditsPerCode: number;
  createdAt: Date;
  createdByUserId: string;
  expiresAt: Date;
  redeemedAt: Date | null;
  redeemedByUserId: string | null;
  redeemedByOrgId: string | null;
}

const LIST_REDEMPTION_CODES_LIMIT = 500;

/**
 * Return minted redemption codes newest-first, with redemption status. Staff
 * use this to trace which codes are outstanding, who redeemed what, and when.
 * Callers must already have passed the staff gate at the route layer — this
 * function does no authorization.
 */
export async function listRedemptionCodes(): Promise<ListedRedemptionCode[]> {
  const db = globalThis.services.db;
  const rows = await db
    .select({
      code: redemptionCodes.code,
      creditsPerCode: redemptionCodes.creditsPerCode,
      createdAt: redemptionCodes.createdAt,
      createdByUserId: redemptionCodes.createdByUserId,
      expiresAt: redemptionCodes.expiresAt,
      redeemedAt: redemptionCodes.redeemedAt,
      redeemedByUserId: redemptionCodes.redeemedByUserId,
      redeemedByOrgId: redemptionCodes.redeemedByOrgId,
    })
    .from(redemptionCodes)
    .orderBy(desc(redemptionCodes.createdAt))
    .limit(LIST_REDEMPTION_CODES_LIMIT);
  return rows;
}
