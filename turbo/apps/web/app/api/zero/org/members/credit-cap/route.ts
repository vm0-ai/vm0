import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import {
  getMemberCreditCap,
  setMemberCreditCap,
} from "../../../../../../src/lib/zero/credit/member-credit-cap-service";

const updateBodySchema = z.object({
  userId: z.string().min(1),
  creditCap: z.number().int().positive().nullable(),
});

function unauthenticatedJsonResponse() {
  return NextResponse.json(
    { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
    { status: 401 },
  );
}

/**
 * GET /api/zero/org/members/credit-cap?userId={userId}
 *
 * Get a member's credit cap configuration.
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
  if (!authResult.orgId) {
    return unauthenticatedJsonResponse();
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get("userId");

  if (!userId) {
    return NextResponse.json(
      { error: "Missing required query parameter: userId" },
      { status: 400 },
    );
  }

  const { org } = await resolveOrg(authResult);
  const result = await getMemberCreditCap(org.orgId, userId);

  return NextResponse.json({
    userId,
    creditCap: result.creditCap,
    creditEnabled: result.creditEnabled,
  });
}

/**
 * PUT /api/zero/org/members/credit-cap
 *
 * Set or clear a member's credit cap.
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

  const { org, member } = await resolveOrg(authResult);

  // Only admins can update credit caps
  if (member.role !== "admin") {
    return NextResponse.json(
      { error: "Only org admins can update member credit caps" },
      { status: 403 },
    );
  }

  const parsed = updateBodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: `Invalid body — ${parsed.error.issues
          .map((i) => {
            return i.message;
          })
          .join(", ")}`,
      },
      { status: 400 },
    );
  }

  const result = await setMemberCreditCap(
    org.orgId,
    parsed.data.userId,
    parsed.data.creditCap,
  );

  return NextResponse.json({
    userId: parsed.data.userId,
    creditCap: result.creditCap,
    creditEnabled: result.creditEnabled,
  });
}
