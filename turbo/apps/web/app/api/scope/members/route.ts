import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { requireScopeFromRequest } from "../../../../src/lib/scope/resolve-scope";
import {
  getScopeMembers,
  removeMember,
} from "../../../../src/lib/scope/scope-member-service";
import {
  isBadRequest,
  isNotFound,
  isForbidden,
} from "../../../../src/lib/errors";

/**
 * GET /api/scope/members - Get scope members and status
 */
export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization") ?? undefined;
  const authCtx = await getAuthContext(authHeader);
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const { userId, orgId: tokenOrgId } = authCtx;

  try {
    const { scope } = await requireScopeFromRequest(
      request,
      userId,
      tokenOrgId,
    );
    const status = await getScopeMembers(userId, scope.orgId, scope.slug);
    return NextResponse.json(status);
  } catch (error) {
    if (isBadRequest(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
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

/**
 * DELETE /api/scope/members - Remove a member from the scope
 */
export async function DELETE(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization") ?? undefined;
  const authCtx = await getAuthContext(authHeader);
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const { userId, orgId: tokenOrgId } = authCtx;

  const body = (await request.json()) as { email: string };
  if (!body.email) {
    return NextResponse.json(
      { error: { message: "Email is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  try {
    const { scope, member } = await requireScopeFromRequest(
      request,
      userId,
      tokenOrgId,
    );
    await removeMember(userId, scope.orgId, member.role, body.email);
    return NextResponse.json({
      message: `Removed ${body.email} from scope`,
    });
  } catch (error) {
    if (isBadRequest(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
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
