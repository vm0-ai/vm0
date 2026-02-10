import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { getUserAccessibleScopes } from "../../../../src/lib/scope/scope-service";

/**
 * GET /api/scope/list - List all accessible scopes
 *
 * Returns the user's personal scope and all organizations they are a member of.
 */
export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);
  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const scopes = await getUserAccessibleScopes(userId);

  // Get current scope from header if provided
  const currentScope = request.headers.get("x-vm0-scope") ?? undefined;

  return NextResponse.json({
    scopes: scopes.map((s) => ({
      id: s.id,
      slug: s.slug,
      type: s.type,
      role: s.role,
    })),
    currentScope,
  });
}
