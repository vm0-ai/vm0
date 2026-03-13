import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { requireOrgFromRequest } from "../../../../src/lib/org/resolve-org";
import {
  getOrgMembers,
  removeMember,
} from "../../../../src/lib/org/org-member-service";
import {
  isBadRequest,
  isNotFound,
  isForbidden,
} from "../../../../src/lib/errors";

const removeMemberBodySchema = z.object({ email: z.string().email() });

/**
 * GET /api/org/members - Get org members and status
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
    const { org } = await requireOrgFromRequest(request, userId, tokenOrgId);
    const status = await getOrgMembers(userId, org.orgId, org.slug);
    return NextResponse.json(status);
  } catch (error) {
    if (isBadRequest(error)) {
      return NextResponse.json(
        { error: { message: "Invalid request", code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
    if (isForbidden(error)) {
      return NextResponse.json(
        { error: { message: "Access denied", code: "FORBIDDEN" } },
        { status: 403 },
      );
    }
    if (isNotFound(error)) {
      return NextResponse.json(
        { error: { message: "Resource not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    throw error;
  }
}

/**
 * DELETE /api/org/members - Remove a member from the org
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

  const parseResult = removeMemberBodySchema.safeParse(
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
    const { org, member } = await requireOrgFromRequest(
      request,
      userId,
      tokenOrgId,
    );
    await removeMember(userId, org.orgId, member.role, body.email);
    return NextResponse.json({
      message: `Removed ${body.email} from scope`,
    });
  } catch (error) {
    if (isBadRequest(error)) {
      return NextResponse.json(
        { error: { message: "Invalid request", code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
    if (isForbidden(error)) {
      return NextResponse.json(
        { error: { message: "Access denied", code: "FORBIDDEN" } },
        { status: 403 },
      );
    }
    if (isNotFound(error)) {
      return NextResponse.json(
        { error: { message: "Resource not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    throw error;
  }
}
