import { NextResponse } from "next/server";
import { z } from "zod";
import { connectorTypeSchema } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { upsertOAuthConnector } from "../../../../../src/lib/connector/connector-service";
import {
  resolveTestUserId,
  isTestVariant,
} from "../../../../../src/lib/auth/test-user";
import { getDefaultScopeByClerkUserId } from "../../../../../src/lib/scope/scope-service";
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
 * Query: ?variant=serial|runner (default: serial)
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
  const variant = url.searchParams.get("variant") ?? "serial";
  if (!isTestVariant(variant)) {
    return NextResponse.json(
      { error: `Unknown test variant: ${variant}` },
      { status: 400 },
    );
  }

  const userId = await resolveTestUserId(variant);
  if (!userId) {
    return NextResponse.json({ error: "Test user not found" }, { status: 500 });
  }

  const scope = await getDefaultScopeByClerkUserId(userId);
  if (!scope) {
    return NextResponse.json(
      { error: "Test user has no scope — run test-token first" },
      { status: 400 },
    );
  }

  await upsertOAuthConnector(
    scope.clerkOrgId,
    scope.id,
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
    scopeId: scope.id,
  });
}
