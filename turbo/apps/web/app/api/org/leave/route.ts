import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { getScopeBySlug } from "../../../../src/lib/scope/scope-service";
import { requireScopeMember } from "../../../../src/lib/scope/scope-member-service";
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

  const url = new URL(request.url);
  const scopeSlug = url.searchParams.get("scope");
  if (!scopeSlug) {
    return NextResponse.json(
      {
        error: {
          message: "scope query parameter is required",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  const scope = await getScopeBySlug(scopeSlug);
  if (!scope) {
    return NextResponse.json(
      { error: { message: "Scope not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  const member = await requireScopeMember(scope.id, userId);

  try {
    await leaveOrganization(
      userId,
      scope.id,
      member.role as "admin" | "member",
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
