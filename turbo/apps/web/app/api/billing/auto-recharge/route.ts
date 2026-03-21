import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { orgMetadata } from "../../../../src/db/schema/org-metadata";
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

  const db = globalThis.services.db;
  const [row] = await db
    .select({
      autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
      autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
      autoRechargeAmount: orgMetadata.autoRechargeAmount,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, org.orgId))
    .limit(1);

  return NextResponse.json({
    enabled: row?.autoRechargeEnabled ?? false,
    threshold: row?.autoRechargeThreshold ?? null,
    amount: row?.autoRechargeAmount ?? null,
  });
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

  const { enabled, threshold, amount } = parsed.data;

  // When enabling, threshold and amount are required, and org must be on a paid tier
  if (enabled) {
    if (org.tier === "free") {
      return NextResponse.json(
        { error: "Auto-recharge is only available for paid plans (Pro/Max)" },
        { status: 400 },
      );
    }

    if (threshold === undefined || amount === undefined) {
      return NextResponse.json(
        {
          error:
            "threshold and amount are required when enabling auto-recharge",
        },
        { status: 400 },
      );
    }
  }

  const db = globalThis.services.db;
  await db
    .update(orgMetadata)
    .set({
      autoRechargeEnabled: enabled,
      autoRechargeThreshold: enabled ? threshold : null,
      autoRechargeAmount: enabled ? amount : null,
      // Clear pending state when disabling
      ...(!enabled ? { autoRechargePendingAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(orgMetadata.orgId, org.orgId));

  return NextResponse.json({
    enabled,
    threshold: enabled ? threshold : null,
    amount: enabled ? amount : null,
  });
}
