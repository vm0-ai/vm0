import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { requireOrgAuth } from "../../../../src/lib/org/require-org-auth";
import { leaveOrganization } from "../../../../src/lib/org/org-service";
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

  const orgResult = await requireOrgAuth(authHeader);
  if (!orgResult.ok) {
    return NextResponse.json(
      {
        error: { message: orgResult.error.message, code: orgResult.error.code },
      },
      { status: orgResult.error.status },
    );
  }

  try {
    await leaveOrganization(
      userId,
      orgResult.auth.scopeId,
      orgResult.auth.role,
    );
    return NextResponse.json({ message: "Left organization" });
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
