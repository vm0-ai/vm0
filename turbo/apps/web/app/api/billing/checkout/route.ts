import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { createCheckoutSession } from "../../../../src/lib/billing/billing-service";

const checkoutBodySchema = z.object({
  tier: z.enum(["pro", "max"]),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

/**
 * POST /api/billing/checkout
 *
 * Create a Stripe Checkout session for subscribing to a plan.
 * Body: { tier: "pro" | "max" }
 * Returns: { url: string }
 */
export async function POST(request: Request) {
  initServices();

  const { STRIPE_SECRET_KEY, ZERO_PRO_PLAN_PRICE_ID, ZERO_MAX_PLAN_PRICE_ID } =
    env();

  if (!STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { error: "Billing not configured" },
      { status: 503 },
    );
  }

  const authResult = await requireAuth(
    request.headers.get("authorization") ?? undefined,
  );
  if (isAuthError(authResult)) {
    return NextResponse.json(authResult.body, { status: authResult.status });
  }

  const orgSlug = new URL(request.url).searchParams.get("org");
  const { org } = await resolveOrg(authResult, orgSlug);

  const parsed = checkoutBodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          'Invalid body — requires tier ("pro"|"max"), successUrl, cancelUrl',
      },
      { status: 400 },
    );
  }
  const { tier, successUrl, cancelUrl } = parsed.data;

  const priceId =
    tier === "pro" ? ZERO_PRO_PLAN_PRICE_ID : ZERO_MAX_PLAN_PRICE_ID;
  if (!priceId) {
    return NextResponse.json(
      { error: `Price not configured for ${tier} tier` },
      { status: 503 },
    );
  }

  const url = await createCheckoutSession(
    org.orgId,
    org.slug,
    priceId,
    successUrl,
    cancelUrl,
  );

  return NextResponse.json({ url });
}
