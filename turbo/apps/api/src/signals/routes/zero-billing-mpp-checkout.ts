import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Handler } from "hono";
import { Mppx, stripe as mppxStripe } from "mppx/server";

import { db } from "../../lib/db";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import {
  verifyCliToken,
  verifyZeroToken,
  verifySandboxToken,
  isPatToken,
  isSandboxToken,
} from "../auth/tokens";

const log = logger("billing:mpp-checkout");

const TIER_MONTHLY_CREDITS = Object.freeze<Record<string, number>>({
  pro: 20_000,
  team: 120_000,
});

const CREDITS_PER_DOLLAR = 1000;

// ── Helpers ──────────────────────────────────────────────────────────────

function tierPriceCents(tier: string): number {
  const credits = TIER_MONTHLY_CREDITS[tier];
  if (!credits) {
    throw new Error(`Unknown tier: ${tier}`);
  }
  return (credits / CREDITS_PER_DOLLAR) * 100;
}

function createMppx() {
  return Mppx.create({
    methods: [
      mppxStripe.charge({
        networkId: "vm0",
        paymentMethodTypes: ["card", "link"],
        secretKey: env("STRIPE_SECRET_KEY"),
      }),
    ],
    secretKey: env("MPP_SECRET_KEY"),
  });
}

function resolveOrgFromToken(token: string): string | null {
  if (isPatToken(token)) {
    const cliAuth = verifyCliToken(token);
    return cliAuth?.orgId ?? null;
  }
  if (isSandboxToken(token)) {
    return (
      verifyZeroToken(token)?.orgId ??
      verifySandboxToken(token)?.orgId ??
      verifyCliToken(token)?.orgId ??
      null
    );
  }
  return null;
}

/** Result from a successful mppx charge — has the withReceipt helper. */
interface MppChargeSuccess {
  status: 200;
  withReceipt: (response: Response) => Response;
}

interface MppChargeChallenge {
  status: 402;
  challenge: Response;
}

type MppChargeResult = MppChargeSuccess | MppChargeChallenge;

// ── Credit Granting ──────────────────────────────────────────────────────

async function grantMppCredits(
  orgId: string,
  tier: string,
  paymentRef: string,
): Promise<void> {
  const credits = TIER_MONTHLY_CREDITS[tier];
  if (!credits) {
    return;
  }

  const d = db();
  await d.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(creditExpiresRecord)
      .values({
        orgId,
        source: "one_time_purchase",
        stripeInvoiceId: paymentRef,
        amount: credits,
        remaining: credits,
        expiresAt: new Date("2999-12-31T00:00:00Z"),
      })
      .onConflictDoNothing()
      .returning({ id: creditExpiresRecord.id });

    if (!inserted) {
      log.debug("MPP credits already granted — idempotent replay", {
        orgId,
        paymentRef,
      });
      return;
    }

    const [current] = await tx
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    const activeTier =
      current?.tier === "free" || !current?.tier ? tier : current.tier;

    await tx
      .insert(orgMetadata)
      .values({
        orgId,
        tier: activeTier,
        credits,
        subscriptionStatus: "active",
      })
      .onConflictDoUpdate({
        target: orgMetadata.orgId,
        set: {
          tier: activeTier,
          credits: sql`${orgMetadata.credits} + ${credits}`,
          subscriptionStatus: "active",
          updatedAt: nowDate(),
        },
      });

    log.debug("MPP credits granted", { orgId, tier, credits, paymentRef });
  });
}

// ── Handler ──────────────────────────────────────────────────────────────

/**
 * MPP Checkout handler — two-phase payment flow for agent-driven plan
 * purchases via link-cli.
 *
 * Phase 1 (Bearer auth):
 *   GET /api/zero/billing/mpp/checkout?tier=pro&org=<orgId>
 *   Authorization: Bearer <PAT|zero|sandbox>
 *   → 402 Payment Required + WWW-Authenticate challenge
 *
 * Phase 2 (Payment auth):
 *   GET /api/zero/billing/mpp/checkout?tier=pro&org=<orgId>
 *   Authorization: Payment <credential>
 *   → 200 OK + Payment-Receipt + credits granted + tier upgraded
 */
export const mppCheckoutHandler: Handler = async (c) => {
  const authHeader = c.req.header("authorization") ?? "";
  const tier = c.req.query("tier");

  if (!tier || !(tier in TIER_MONTHLY_CREDITS)) {
    return c.json(
      { error: { message: "tier must be pro or team", code: "BAD_REQUEST" } },
      400,
    );
  }

  const amountCents = tierPriceCents(tier);

  // Phase 1: Bearer auth
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const orgId = resolveOrgFromToken(token);
    if (!orgId) {
      return c.json(
        { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
        401,
      );
    }

    const urlOrg = c.req.query("org");
    if (urlOrg && urlOrg !== orgId) {
      return c.json(
        { error: { message: "Forbidden", code: "FORBIDDEN" } },
        403,
      );
    }

    const mppx = createMppx();
    const result = (await mppx.stripe.charge({
      amount: String(amountCents),
      currency: "usd",
      decimals: 2,
    })(c.req.raw)) as MppChargeResult;

    if (result.status === 402) {
      return result.challenge;
    }

    return handleMppSuccess(c, result, orgId, tier);
  }

  // Phase 2: Payment credential
  if (authHeader.startsWith("Payment ")) {
    const orgId = c.req.query("org");
    if (!orgId) {
      return c.json(
        { error: { message: "org query param required", code: "BAD_REQUEST" } },
        400,
      );
    }

    const mppx = createMppx();
    const result = (await mppx.stripe.charge({
      amount: String(amountCents),
      currency: "usd",
      decimals: 2,
    })(c.req.raw)) as MppChargeResult;

    if (result.status === 402) {
      // Credential invalid/expired — mppx returns a fresh challenge
      return result.challenge;
    }

    return handleMppSuccess(c, result, orgId, tier);
  }

  return c.json(
    { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
    401,
  );
};

// ── Success ──────────────────────────────────────────────────────────────

async function handleMppSuccess(
  c: Parameters<Handler>[0],
  result: MppChargeSuccess,
  orgId: string,
  tier: string,
): Promise<Response> {
  const paymentRef = `mpp_${randomUUID()}`;

  await grantMppCredits(orgId, tier, paymentRef);

  return result.withReceipt(c.json({ status: "paid", tier, orgId }));
}
