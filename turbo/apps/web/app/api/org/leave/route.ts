import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { leaveOrg } from "../../../../src/lib/org/org-member-service";
import {
  badRequest,
  isBadRequest,
  isNotFound,
  isForbidden,
} from "../../../../src/lib/errors";

/**
 * POST /api/org/leave - Leave the current org
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
  const { userId } = authCtx;

  try {
    const orgSlug = new URL(request.url).searchParams.get("org");
    if (!orgSlug) throw badRequest("org query parameter is required");
    const { org, member } = await resolveOrg(userId, orgSlug);
    await leaveOrg(userId, org.orgId, member.role);
    return NextResponse.json({ message: "Left org" });
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
