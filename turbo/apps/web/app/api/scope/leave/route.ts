import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { requireScopeFromRequest } from "../../../../src/lib/scope/resolve-scope";
import { leaveScope } from "../../../../src/lib/scope/scope-member-service";
import {
  isBadRequest,
  isNotFound,
  isForbidden,
} from "../../../../src/lib/errors";

/**
 * POST /api/scope/leave - Leave the current scope
 */
export async function POST(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization") ?? undefined;
  const authCtx = await getAuthContext(authHeader);
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const { userId, scopeId: tokenScopeId } = authCtx;

  try {
    const { scope, member } = await requireScopeFromRequest(
      request,
      userId,
      tokenScopeId,
    );
    await leaveScope(userId, scope.id, member.role);
    return NextResponse.json({ message: "Left scope" });
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
