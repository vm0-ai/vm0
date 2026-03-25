import { NextResponse } from "next/server";
import crypto from "crypto";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { getOrgBySlug } from "../../../../../src/lib/org/org-cache-service";
import { verifyMembershipCached } from "../../../../../src/lib/org/org-membership-cache";
import { generateCliToken } from "../../../../../src/lib/auth/sandbox-token";
import { cliTokens } from "../../../../../src/db/schema/cli-tokens";

/**
 * Switch active organization and get a new CLI JWT.
 *
 * Requires Bearer token authentication (vm0_live_ or CLI JWT).
 * Validates that the user is a member of the target organization.
 */
export async function POST(request: Request) {
  initServices();

  // 1. Authenticate — accept both vm0_live_ and CLI JWT
  const authHeader = request.headers.get("authorization") ?? undefined;
  const authCtx = await getAuthContext(authHeader);
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Authentication required", code: "unauthorized" } },
      { status: 401 },
    );
  }

  // 2. Parse request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_request", error_description: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const slug =
    typeof body === "object" && body !== null && "slug" in body
      ? (body as Record<string, unknown>).slug
      : undefined;
  if (!slug || typeof slug !== "string" || slug.length === 0) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "slug is required" },
      { status: 400 },
    );
  }

  // 3. Resolve org by slug
  const orgData = await getOrgBySlug(slug);
  if (!orgData) {
    return NextResponse.json(
      { error: { message: "Organization not found", code: "not_found" } },
      { status: 404 },
    );
  }

  // 4. Verify membership
  const membership = await verifyMembershipCached(
    orgData.orgId,
    authCtx.userId,
  );
  if (!membership) {
    return NextResponse.json(
      {
        error: {
          message: "Not a member of this organization",
          code: "forbidden",
        },
      },
      { status: 403 },
    );
  }

  // 5. Generate new CLI JWT with target org
  const tokenId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days
  const cliToken = await generateCliToken(
    authCtx.userId,
    orgData.orgId,
    tokenId,
  );

  await globalThis.services.db.insert(cliTokens).values({
    id: tokenId,
    token: cliToken,
    userId: authCtx.userId,
    name: "CLI Org Switch",
    expiresAt,
    createdAt: now,
  });

  return NextResponse.json({
    access_token: cliToken,
    token_type: "Bearer",
    expires_in: 90 * 24 * 60 * 60,
    org_slug: orgData.slug,
  });
}
