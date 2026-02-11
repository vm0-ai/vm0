import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  getUserOwnedOrganization,
  isOrgOwner,
  createInviteLink,
} from "../../../../src/lib/org/org-service";
import {
  resolveRequestScope,
  isScopeResolutionSuccess,
} from "../../../../src/lib/scope/resolve-request-scope";

/**
 * POST /api/org/invite - Create organization invite link
 *
 * Only the organization owner can create invite links.
 * Uses X-VM0-Scope header to determine which org.
 */
export async function POST(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);
  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  // Get scope from header or default to user's owned org
  const scopeHeader = request.headers.get("x-vm0-scope");

  let orgScope;
  if (scopeHeader) {
    const result = await resolveRequestScope(userId, scopeHeader);
    if (!isScopeResolutionSuccess(result)) {
      const status = result.code === "FORBIDDEN" ? 403 : 404;
      return NextResponse.json(
        { error: { message: result.error, code: result.code } },
        { status },
      );
    }
    if (result.scope.type !== "organization") {
      return NextResponse.json(
        {
          error: {
            message: "Scope is not an organization",
            code: "BAD_REQUEST",
          },
        },
        { status: 400 },
      );
    }
    orgScope = result.scope;
  } else {
    // Default to user's owned org
    orgScope = await getUserOwnedOrganization(userId);
    if (!orgScope) {
      return NextResponse.json(
        {
          error: {
            message:
              "You don't have an organization. Create one with: vm0 scope org create <slug>",
            code: "NOT_FOUND",
          },
        },
        { status: 404 },
      );
    }
  }

  // Verify user is owner
  const isOwner = await isOrgOwner(userId, orgScope.id);
  if (!isOwner) {
    return NextResponse.json(
      {
        error: {
          message: "Only the organization owner can create invite links",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  // Create invite link
  const { token, expiresAt } = await createInviteLink(orgScope.id, userId);

  // Build invite URL
  // Priority: WEB_APP_URL (explicit config) > VERCEL_URL (auto-set by Vercel)
  const baseUrl =
    process.env.WEB_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  if (!baseUrl) {
    return NextResponse.json(
      {
        error: {
          message:
            "Server configuration error: WEB_APP_URL or VERCEL_URL not set",
          code: "INTERNAL_ERROR",
        },
      },
      { status: 500 },
    );
  }
  const url = `${baseUrl}/invite/${token}`;

  return NextResponse.json(
    {
      token,
      url,
      expiresAt: expiresAt.toISOString(),
    },
    { status: 201 },
  );
}
