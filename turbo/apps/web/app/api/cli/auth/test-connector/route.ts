import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { connectorTypeSchema } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { upsertOAuthConnector } from "../../../../../src/lib/zero/connector/connector-service";
import {
  resolveTestUserId,
  DEFAULT_TEST_EMAIL,
} from "../../../../../src/lib/auth/test-user";
import { orgMembersCache } from "../../../../../src/db/schema/org-members-cache";
import { getOrgMetadata } from "../../../../../src/lib/zero/org/org-metadata-service";
import { isNotFound } from "../../../../../src/lib/shared/errors";
import { env } from "../../../../../src/env";

const bodySchema = z.object({
  connectorName: z.string(),
  accessToken: z.string(),
});

/**
 * Check if test endpoint is allowed (same guard as test-token).
 * Only available in local development or Vercel preview with bypass secret.
 */
function isAllowed(request: Request): boolean {
  const vercelEnv = env().VERCEL_ENV;
  const nodeEnv = env().NODE_ENV;

  if (!vercelEnv && nodeEnv === "development") {
    return true;
  }

  if (vercelEnv === "preview") {
    const bypassHeader = request.headers.get("x-vercel-protection-bypass");
    const expectedSecret = env().VERCEL_AUTOMATION_BYPASS_SECRET;
    return !!expectedSecret && bypassHeader === expectedSecret;
  }

  return false;
}

/**
 * POST /api/cli/auth/test-connector
 *
 * Test-only endpoint to set up a connector with a known access token.
 * Used by E2E tests to verify proxy-side token replacement.
 *
 * Body: { connectorName: string, accessToken: string }
 * Query: ?email=<email> (default: dev+clerk_test+serial@vm0-e2e.ai)
 */
export async function POST(request: Request) {
  if (!isAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  initServices();

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "connectorName and accessToken are required" },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const connectorParsed = connectorTypeSchema.safeParse(body.connectorName);
  if (!connectorParsed.success) {
    return NextResponse.json(
      { error: `Unknown connector type: "${body.connectorName}"` },
      { status: 400 },
    );
  }
  const connectorType = connectorParsed.data;

  const url = new URL(request.url);
  const email = url.searchParams.get("email") ?? DEFAULT_TEST_EMAIL;
  const userId = await resolveTestUserId(email);

  // Look up test user's org from org_members_cache (populated by test-token endpoint)
  const [cached] = await globalThis.services.db
    .select({ orgId: orgMembersCache.orgId })
    .from(orgMembersCache)
    .where(eq(orgMembersCache.userId, userId))
    .orderBy(desc(orgMembersCache.cachedAt))
    .limit(1);

  let org: { orgId: string; tier: string } | null = null;
  if (cached) {
    try {
      org = await getOrgMetadata(cached.orgId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      // org_members_cache entry exists but org_metadata row doesn't yet — use defaults
      org = { orgId: cached.orgId, tier: "free" };
    }
  }
  if (!org) {
    return NextResponse.json(
      { error: "Test user has no org — run test-token first" },
      { status: 400 },
    );
  }

  await upsertOAuthConnector(
    org.orgId,
    userId,
    connectorType,
    body.accessToken,
    {
      id: `e2e-test-${connectorType}`,
      username: `e2e-${connectorType}`,
      email: `e2e-${connectorType}@test.vm0.ai`,
    },
    [],
  );

  return NextResponse.json({
    ok: true,
    connectorType,
    orgId: org.orgId,
  });
}
