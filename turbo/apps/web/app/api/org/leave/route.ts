import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { leaveOrganization } from "../../../../src/lib/org/org-service";
import {
  resolveRequestScope,
  isScopeResolutionSuccess,
} from "../../../../src/lib/scope/resolve-request-scope";
import { isForbidden, isNotFound } from "../../../../src/lib/errors";

/**
 * POST /api/org/leave - Leave organization (member only)
 *
 * Owner cannot leave - they must delete the organization.
 * Uses X-VM0-Scope header to determine which org to leave.
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

  // Get scope from header - required for leave
  const scopeHeader = request.headers.get("x-vm0-scope");
  if (!scopeHeader) {
    return NextResponse.json(
      {
        error: {
          message: "X-VM0-Scope header is required",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

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
        error: { message: "Scope is not an organization", code: "BAD_REQUEST" },
      },
      { status: 400 },
    );
  }

  try {
    await leaveOrganization(userId, result.scope.id);
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
