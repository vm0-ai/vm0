import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import {
  getAutoRechargeConfig,
  updateAutoRechargeConfig,
} from "../../../../src/lib/billing/billing-service";
import { CREDITS_PER_DOLLAR } from "../../../../src/lib/billing/auto-recharge-service";

const updateBodySchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().int().positive().optional(),
  amount: z.number().int().min(CREDITS_PER_DOLLAR).optional(),
});

/**
 * GET /api/billing/auto-recharge?org={slug}
 *
 * Get auto-recharge configuration for the current org.
 * Any org member can read.
 */
export async function GET(request: Request) {
  initServices();

  const authResult = await requireAuth(
    request.headers.get("authorization") ?? undefined,
  );
  if (isAuthError(authResult)) {
    return NextResponse.json(authResult.body, { status: authResult.status });
  }

  const orgSlug = new URL(request.url).searchParams.get("org");
  const { org } = await resolveOrg(authResult, orgSlug);

  const config = await getAutoRechargeConfig(org.orgId);
  return NextResponse.json(config);
}

/**
 * PUT /api/billing/auto-recharge?org={slug}
 *
 * Update auto-recharge configuration.
 * Only org admins can update.
 */
export async function PUT(request: Request) {
  initServices();

  const authResult = await requireAuth(
    request.headers.get("authorization") ?? undefined,
  );
  if (isAuthError(authResult)) {
    return NextResponse.json(authResult.body, { status: authResult.status });
  }

  const orgSlug = new URL(request.url).searchParams.get("org");
  const { org, member } = await resolveOrg(authResult, orgSlug);

  // Only admins can update auto-recharge settings
  if (member.role !== "admin") {
    return NextResponse.json(
      { error: "Only org admins can update auto-recharge settings" },
      { status: 403 },
    );
  }

  const parsed = updateBodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: `Invalid body — ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      },
      { status: 400 },
    );
  }

  const result = await updateAutoRechargeConfig(
    org.orgId,
    org.tier,
    parsed.data,
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(result.data);
}
