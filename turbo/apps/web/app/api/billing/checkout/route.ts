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

  const { STRIPE_SECRET_KEY, STRIPE_PRICE_ID_PRO, STRIPE_PRICE_ID_MAX } = env();

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
      { error: 'Invalid tier — must be "pro" or "max"' },
      { status: 400 },
    );
  }
  const { tier } = parsed.data;

  const priceId = tier === "pro" ? STRIPE_PRICE_ID_PRO : STRIPE_PRICE_ID_MAX;
  if (!priceId) {
    return NextResponse.json(
      { error: `Price not configured for ${tier} tier` },
      { status: 503 },
    );
  }

  const origin = new URL(request.url).origin;
  const url = await createCheckoutSession(
    org.orgId,
    org.slug,
    priceId,
    `${origin}/settings/billing?success=true`,
    `${origin}/settings/billing?canceled=true`,
  );

  return NextResponse.json({ url });
}
