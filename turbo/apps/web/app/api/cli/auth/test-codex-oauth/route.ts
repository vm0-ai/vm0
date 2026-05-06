import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { initServices } from "../../../../../src/lib/init-services";
import { upsertOrgMultiAuthModelProvider } from "../../../../../src/lib/zero/model-provider/model-provider-service";
import {
  parseCodexAuthJson,
  isCodexAuthJsonShapeError,
  isCodexAuthJsonFreePlanError,
} from "../../../../../src/lib/zero/model-provider/codex-auth-json-parser";
import {
  resolveTestUserId,
  resolveTestUserOrg,
  DEFAULT_TEST_EMAIL,
} from "../../../../../src/lib/auth/test-user";
import { isTestEndpointAllowed } from "../../../../../src/lib/auth/test-endpoint-guard";
import { ORG_SENTINEL_USER_ID } from "../../../../../src/lib/zero/org/org-sentinel";

const legacyBodySchema = z.object({
  /** Real-shaped (but synthetic) tokens. The audit grep asserts these
   *  strings never appear in any sandbox env / file / log. Use high-entropy
   *  values to avoid grep false-positives. */
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accountId: z.string().min(1),
  /** id_token may be a placeholder JWT — exchange-time plan-type validation
   *  is NOT exercised here (the seed bypasses exchangeChatgptCode). */
  idToken: z.string().min(1),
  /** Seconds until access token is considered expired. Negative pre-expires.
   *  Default 600 (10 min) so the run completes before the buffer triggers. */
  expiresIn: z.number().int().optional(),
  /** Marks provider stale — drives Test 4 (stale recovery) probe. */
  needsReconnect: z.boolean().optional(),
  /** Captures ChatgptRefreshError.code for stale-state UX (Wave 3). */
  lastRefreshErrorCode: z.string().nullable().optional(),
});

/**
 * The auth_json variant exercises the production parser path so e2e tests
 * cover the same code as the public POST /api/zero/model-providers route.
 * Use this variant when verifying paste-flow changes; use the legacy variant
 * when seeding a synthetic state directly (e.g. pre-stale provider for
 * stale-recovery tests).
 */
const authJsonBodySchema = z.object({
  authJson: z.string().min(1),
});

const bodySchema = z.union([authJsonBodySchema, legacyBodySchema]);

const DEFAULT_EXPIRES_IN_SECS = 600;

/**
 * POST /api/cli/auth/test-codex-oauth?email=<email>
 *
 * Test-only endpoint for E2E tests of the codex-oauth-token paste flow.
 * Seeds a `codex-oauth-token` model_providers row + the four secrets
 * (CHATGPT_ACCESS_TOKEN, CHATGPT_REFRESH_TOKEN, CHATGPT_ACCOUNT_ID,
 * CHATGPT_ID_TOKEN) under the org-sentinel user, bypassing the browser
 * OAuth dance.
 *
 * Body accepts one of two shapes:
 *  - `{ authJson }` — exercises the production parser (matches the user-facing
 *    POST /api/zero/model-providers paste path).
 *  - legacy fields — direct seed of synthetic state, useful for stale-recovery
 *    probes (sets `needsReconnect`, `lastRefreshErrorCode`, negative
 *    `expiresIn`).
 *
 * Query: ?email=<email> (default: DEFAULT_TEST_EMAIL).
 *
 * Gated by isTestEndpointAllowed — returns 404 in production.
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
      { error: "Invalid body shape", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

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

  if ("authJson" in body) {
    return seedFromAuthJson(org.orgId, body.authJson);
  }
  return seedFromLegacyFields(org.orgId, body);
}

async function seedFromAuthJson(
  orgId: string,
  authJson: string,
): Promise<NextResponse> {
  let parsed;
  try {
    parsed = parseCodexAuthJson(authJson);
  } catch (err) {
    if (isCodexAuthJsonFreePlanError(err)) {
      return NextResponse.json(
        { error: "Free plan rejected by parser" },
        { status: 400 },
      );
    }
    if (isCodexAuthJsonShapeError(err)) {
      return NextResponse.json(
        { error: `auth.json shape invalid: ${err.message}` },
        { status: 400 },
      );
    }
    throw err;
  }

  await upsertOrgMultiAuthModelProvider(
    orgId,
    "codex-oauth-token",
    "oauth",
    {
      CHATGPT_ACCESS_TOKEN: parsed.accessToken,
      CHATGPT_REFRESH_TOKEN: parsed.refreshToken,
      CHATGPT_ACCOUNT_ID: parsed.accountId,
      CHATGPT_ID_TOKEN: parsed.idToken,
    },
    undefined,
    {
      tokenExpiresAt: parsed.tokenExpiresAt,
      workspaceName: parsed.workspaceName,
      planType: parsed.planType,
    },
  );

  return NextResponse.json({
    ok: true,
    orgId,
    tokenExpiresAt: parsed.tokenExpiresAt.toISOString(),
  });
}

async function seedFromLegacyFields(
  orgId: string,
  body: z.infer<typeof legacyBodySchema>,
): Promise<NextResponse> {
  await upsertOrgMultiAuthModelProvider(orgId, "codex-oauth-token", "oauth", {
    CHATGPT_ACCESS_TOKEN: body.accessToken,
    CHATGPT_REFRESH_TOKEN: body.refreshToken,
    CHATGPT_ACCOUNT_ID: body.accountId,
    CHATGPT_ID_TOKEN: body.idToken,
  });

  // Set token state directly — `upsertOrgMultiAuthModelProvider` doesn't
  // accept these fields today (Wave 3 / #11932 widens the signature).
  // Direct UPDATE is appropriate for a test-only endpoint.
  const expiresInSecs = body.expiresIn ?? DEFAULT_EXPIRES_IN_SECS;
  const tokenExpiresAt = new Date(Date.now() + expiresInSecs * 1000);
  await globalThis.services.db
    .update(modelProviders)
    .set({
      tokenExpiresAt,
      needsReconnect: body.needsReconnect ?? false,
      lastRefreshErrorCode: body.lastRefreshErrorCode ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.type, "codex-oauth-token"),
      ),
    );

  return NextResponse.json({
    ok: true,
    orgId,
    tokenExpiresAt: tokenExpiresAt.toISOString(),
  });
}
