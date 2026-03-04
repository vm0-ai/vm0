import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { verifyAndActivateScope } from "../../../../src/lib/org/org-service";
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

  const body = (await request.json()) as { slug: string };
  if (!body.slug) {
    return NextResponse.json(
      { error: { message: "Slug is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  try {
    const result = await verifyAndActivateScope(userId, body.slug);

    return NextResponse.json({
      scope: {
        id: result.scope.id,
        slug: result.scope.slug,
        type: result.scope.type,
        createdAt: result.scope.createdAt.toISOString(),
        updatedAt: result.scope.updatedAt.toISOString(),
      },
      token: result.token,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    if (isNotFound(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    if (isForbidden(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: "FORBIDDEN" } },
        { status: 403 },
      );
    }
    throw error;
  }
}
