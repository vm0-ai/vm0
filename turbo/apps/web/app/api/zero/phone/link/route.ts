import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
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

/** Orgs allowed to use direct phone linking without OTP verification. */
const DIRECT_LINK_ORG_SLUGS = ["vm0"];

/**
 * POST /api/zero/phone/link — directly link a phone number (no OTP).
 * Only allowed for orgs in DIRECT_LINK_ORG_SLUGS (early access).
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

  // Only allow direct linking for approved orgs
  const orgIdentity = await getOrgNameAndSlug(org.orgId);
  if (!DIRECT_LINK_ORG_SLUGS.includes(orgIdentity.slug)) {
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
