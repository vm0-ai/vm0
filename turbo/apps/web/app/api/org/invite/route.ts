import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { requireScopeFromRequest } from "../../../../src/lib/scope/resolve-scope";
import { inviteMember } from "../../../../src/lib/org/org-service";
import {
  isBadRequest,
  isNotFound,
  isForbidden,
} from "../../../../src/lib/errors";

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

  const body = (await request.json()) as { email: string };
  if (!body.email) {
    return NextResponse.json(
      { error: { message: "Email is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  try {
    const { scope, member } = await requireScopeFromRequest(request, userId);
    await inviteMember(userId, scope.id, member.role, body.email);
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
