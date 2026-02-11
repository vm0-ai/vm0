import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { resolveOrgAccessToken } from "../../../../src/lib/org/org-token-service";
import { inviteMember } from "../../../../src/lib/org/org-service";
import { isNotFound, isForbidden } from "../../../../src/lib/errors";

export async function POST(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization") ?? undefined;
  const userId = await getUserId(authHeader);
  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  // Require org access token
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7)
    : null;

  if (!token?.startsWith("vm0_org_")) {
    return NextResponse.json(
      {
        error: {
          message: "Organization access token required",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  const orgAuth = await resolveOrgAccessToken(token);
  if (!orgAuth) {
    return NextResponse.json(
      {
        error: {
          message: "Invalid or expired org token",
          code: "UNAUTHORIZED",
        },
      },
      { status: 401 },
    );
  }

  const body = (await request.json()) as { email: string };
  if (!body.email) {
    return NextResponse.json(
      { error: { message: "Email is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  try {
    await inviteMember(orgAuth.scopeId, orgAuth.role, body.email);
    return NextResponse.json({ message: `Invitation sent to ${body.email}` });
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
