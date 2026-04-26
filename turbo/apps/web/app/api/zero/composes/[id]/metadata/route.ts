/**
 * PATCH /api/zero/composes/:id/metadata
 * Update agent compose metadata (displayName, description, sound).
 */
import { NextResponse } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { updateComposeMetadata } from "../../../../../../src/lib/zero/zero-compose-service";
import { isNotFound } from "@vm0/api-services/errors";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  initServices();

  const { id } = await params;
  const authorization = request.headers.get("authorization") ?? undefined;

  const authCtx = await requireAuth(authorization);
  if (isAuthError(authCtx)) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const { userId } = authCtx;

  const { org } = await resolveOrg(authCtx);

  const body = await request.json();

  try {
    await updateComposeMetadata(id, userId, org.orgId, body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isNotFound(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    throw error;
  }
}
