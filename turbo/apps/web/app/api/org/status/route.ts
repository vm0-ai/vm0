import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  getUserOwnedOrganization,
  getOrgMembers,
  isOrgMember,
} from "../../../../src/lib/org/org-service";
import {
  resolveRequestScope,
  isScopeResolutionSuccess,
} from "../../../../src/lib/scope/resolve-request-scope";

/**
 * GET /api/org/status - Get organization status with members
 *
 * Uses X-VM0-Scope header to determine which org to get status for.
 * User must be a member of the organization.
 */
export async function GET(request: Request) {
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

  // Verify user is a member
  const isMember = await isOrgMember(userId, orgScope.id);
  if (!isMember) {
    return NextResponse.json(
      {
        error: {
          message: "You are not a member of this organization",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  // Get members
  const members = await getOrgMembers(orgScope.id);

  return NextResponse.json({
    id: orgScope.id,
    slug: orgScope.slug,
    type: "organization",
    createdAt: orgScope.createdAt.toISOString(),
    updatedAt: orgScope.updatedAt.toISOString(),
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt?.toISOString() ?? m.createdAt.toISOString(),
    })),
    memberCount: members.length,
  });
}
