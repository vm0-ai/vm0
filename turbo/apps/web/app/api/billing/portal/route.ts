import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { createBillingPortalSession } from "../../../../src/lib/billing/billing-service";

const portalBodySchema = z.object({
  returnUrl: z.string().min(1),
});

/**
 * POST /api/billing/portal
 *
 * Create a Stripe Billing Portal session for managing subscriptions.
 * Body: { returnUrl: string }
 * Returns: { url: string }
 */
export async function POST(request: Request) {
  initServices();

  const { STRIPE_SECRET_KEY } = env();

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

  const parsed = portalBodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "returnUrl is required" },
      { status: 400 },
    );
  }

  const url = await createBillingPortalSession(
    org.orgId,
    parsed.data.returnUrl,
  );

  return NextResponse.json({ url });
}
