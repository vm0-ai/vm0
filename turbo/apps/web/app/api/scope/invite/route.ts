import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { requireScopeFromRequest } from "../../../../src/lib/scope/resolve-scope";
import { inviteMember } from "../../../../src/lib/scope/scope-member-service";
import {
  isBadRequest,
  isNotFound,
  isForbidden,
} from "../../../../src/lib/errors";

const inviteBodySchema = z.object({ email: z.string().email() });

/**
 * POST /api/scope/invite - Invite a member to the scope
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
  const { userId, orgId: tokenOrgId } = authCtx;

  const parseResult = inviteBodySchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { message: "Invalid email format", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }
  const body = parseResult.data;

  try {
    const { scope, member } = await requireScopeFromRequest(
      request,
      userId,
      tokenOrgId,
    );
    await inviteMember(userId, scope.orgId, member.role, body.email);
    return NextResponse.json({ message: `Invitation sent to ${body.email}` });
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
