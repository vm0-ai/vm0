import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  getInvitation,
  isInvitationValid,
  acceptInvitation,
} from "../../../../src/lib/org/org-service";
import { isBadRequest, isNotFound } from "../../../../src/lib/errors";

interface RouteParams {
  params: Promise<{ token: string }>;
}

/**
 * GET /api/invite/:token - Get invitation details
 *
 * Public endpoint - no auth required.
 * Returns org name and whether the invitation is valid.
 */
export async function GET(_request: Request, { params }: RouteParams) {
  initServices();

  const { token } = await params;

  const inviteData = await getInvitation(token);
  if (!inviteData) {
    return NextResponse.json(
      { error: { message: "Invitation not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  const { invitation, scope } = inviteData;
  const isValid = isInvitationValid(invitation);

  return NextResponse.json({
    orgSlug: scope.slug,
    orgName: scope.slug, // Using slug as name for now
    expiresAt: invitation.expiresAt.toISOString(),
    isValid,
  });
}

/**
 * POST /api/invite/:token/accept - Accept invitation
 *
 * Requires authentication.
 * Adds user to organization and marks invitation as used.
 */
export async function POST(request: Request, { params }: RouteParams) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);
  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { token } = await params;

  try {
    const scope = await acceptInvitation(token, userId);
    return NextResponse.json({
      id: scope.id,
      slug: scope.slug,
      type: scope.type,
      createdAt: scope.createdAt.toISOString(),
      updatedAt: scope.updatedAt.toISOString(),
    });
  } catch (error) {
    if (isNotFound(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    if (isBadRequest(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
    throw error;
  }
}
