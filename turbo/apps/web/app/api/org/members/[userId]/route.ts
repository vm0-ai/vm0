import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  getUserOwnedOrganization,
  isOrgOwner,
  removeOrgMember,
} from "../../../../../src/lib/org/org-service";
import {
  resolveRequestScope,
  isScopeResolutionSuccess,
} from "../../../../../src/lib/scope/resolve-request-scope";
import { isForbidden, isNotFound } from "../../../../../src/lib/errors";

interface RouteParams {
  params: Promise<{ userId: string }>;
}

/**
 * DELETE /api/org/members/:userId - Remove member from organization
 *
 * Only the organization owner can remove members.
 * Owner cannot remove themselves.
 */
export async function DELETE(request: Request, { params }: RouteParams) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const currentUserId = await getUserId(authHeader ?? undefined);
  if (!currentUserId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { userId: targetUserId } = await params;

  // Get scope from header or default to user's owned org
  const scopeHeader = request.headers.get("x-vm0-scope");

  let orgScope;
  if (scopeHeader) {
    const result = await resolveRequestScope(currentUserId, scopeHeader);
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
    orgScope = await getUserOwnedOrganization(currentUserId);
    if (!orgScope) {
      return NextResponse.json(
        {
          error: {
            message: "You don't have an organization",
            code: "NOT_FOUND",
          },
        },
        { status: 404 },
      );
    }
  }

  // Verify current user is owner
  const isOwner = await isOrgOwner(currentUserId, orgScope.id);
  if (!isOwner) {
    return NextResponse.json(
      {
        error: {
          message: "Only the organization owner can remove members",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  try {
    await removeOrgMember(orgScope.id, targetUserId);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbidden(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: "FORBIDDEN" } },
        { status: 403 },
      );
    }
    if (isNotFound(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    throw error;
  }
}
