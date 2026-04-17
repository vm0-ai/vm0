import { NextResponse } from "next/server";
import { z } from "zod";
import { connectorTypeSchema } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { upsertOAuthConnector } from "../../../../../src/lib/zero/connector/connector-service";
import { PROVIDER_HANDLERS } from "../../../../../src/lib/zero/connector/provider-registry";
import {
  resolveTestUserId,
  resolveTestUserOrg,
  DEFAULT_TEST_EMAIL,
} from "../../../../../src/lib/auth/test-user";
import { isTestEndpointAllowed } from "../../../../../src/lib/auth/test-endpoint-guard";

const bodySchema = z.object({
  connectorName: z.string(),
  accessToken: z.string(),
  /** Optional refresh token. Stored under handler's getRefreshSecretName(). */
  refreshToken: z.string().min(1).optional(),
  /**
   * Seconds until the access token is considered expired. May be negative
   * (already-expired) to drive the mid-run refresh path in E2E tests.
   * Default: upsertOAuthConnector's own default (1h for refreshable types).
   */
  expiresIn: z.number().int().optional(),
});

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
  if (!isTestEndpointAllowed(request)) {
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
  const org = await resolveTestUserOrg(userId);
  if (!org) {
    return NextResponse.json(
      { error: "Test user has no org — run test-token first" },
      { status: 400 },
    );
  }

  const handler =
    connectorType === "computer" ? null : PROVIDER_HANDLERS[connectorType];
  const refreshSecretName = handler?.getRefreshSecretName?.();

  const hasOptionalFields =
    body.refreshToken !== undefined || body.expiresIn !== undefined;

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
    hasOptionalFields
      ? {
          refreshToken: body.refreshToken,
          refreshSecretName,
          expiresIn: body.expiresIn,
        }
      : undefined,
  );

  return NextResponse.json({
    ok: true,
    connectorType,
    orgId: org.orgId,
  });
}
