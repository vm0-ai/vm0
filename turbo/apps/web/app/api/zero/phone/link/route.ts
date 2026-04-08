import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { getOrgNameAndSlug } from "../../../../../src/lib/auth/org-cache";
import { phoneUserLinks } from "../../../../../src/db/schema/phone-user-link";

const linkSchema = z.object({
  phoneNumber: z
    .string()
    .regex(/^\+[1-9]\d{1,14}$/, "Use E.164 format (e.g. +14155551234)"),
});

/**
 * POST /api/zero/phone/link — directly link a phone number (no OTP).
 * Only allowed for orgs with slug "vm0" (early access).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { org } = await resolveOrg(authCtx);

  // Only allow direct linking for the vm0 org
  const orgIdentity = await getOrgNameAndSlug(org.orgId);
  if (orgIdentity.slug !== "vm0") {
    return NextResponse.json(
      { error: "Direct phone linking is not available for this org" },
      { status: 403 },
    );
  }

  const parsed = linkSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const { phoneNumber } = parsed.data;

  await globalThis.services.db
    .insert(phoneUserLinks)
    .values({
      phoneNumber,
      orgId: org.orgId,
      vm0UserId: authCtx.userId,
      verified: true,
    })
    .onConflictDoUpdate({
      target: [phoneUserLinks.phoneNumber, phoneUserLinks.orgId],
      set: {
        vm0UserId: authCtx.userId,
        verified: true,
        otpHash: null,
        otpExpiresAt: null,
        updatedAt: new Date(),
      },
    });

  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/zero/phone/link — remove phone link.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { org } = await resolveOrg(authCtx);

  const { eq, and } = await import("drizzle-orm");
  await globalThis.services.db
    .delete(phoneUserLinks)
    .where(
      and(
        eq(phoneUserLinks.orgId, org.orgId),
        eq(phoneUserLinks.vm0UserId, authCtx.userId),
      ),
    );

  return NextResponse.json({ success: true });
}
