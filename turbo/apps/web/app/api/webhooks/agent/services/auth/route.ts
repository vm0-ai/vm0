import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifySandboxToken } from "../../../../../../src/lib/auth/sandbox-token";
import type { SandboxAuth } from "../../../../../../src/lib/auth/sandbox-token";
import { decryptSecretsMap } from "../../../../../../src/lib/crypto/secrets-encryption";
import { logger } from "../../../../../../src/lib/logger";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import {
  refreshConnectorAccessToken,
  getConnectorExpiry,
} from "../../../../../../src/lib/connector/connector-service";

const bodySchema = z.object({
  encryptedSecrets: z.string().min(1),
  authHeaders: z.record(z.string(), z.string()),
  secretConnectorMap: z.record(z.string(), z.string()).optional(),
});

const log = logger("webhook:service-auth");

/** Matches ${secrets.KEY_NAME} template placeholders in auth header values. */
const SECRET_TEMPLATE_RE = /\$\{secrets\.([^}]+)\}/g;

/**
 * Refresh expired OAuth tokens referenced by auth templates.
 * Mutates `secrets` in place with fresh token values.
 * Returns the earliest expiry timestamp (epoch seconds) or null if all are non-expiring.
 */
async function refreshExpiredTokens(
  auth: SandboxAuth,
  secrets: Record<string, string>,
  secretConnectorMap: Record<string, string>,
  referencedKeys: Set<string>,
): Promise<number | null> {
  // Find which referenced secrets are refreshable OAuth tokens
  const refreshable = new Map<string, string>();
  for (const key of referencedKeys) {
    const connectorType = secretConnectorMap[key];
    if (connectorType) refreshable.set(key, connectorType);
  }
  if (refreshable.size === 0) return null;

  // Look up orgId from runId
  const [run] = await globalThis.services.db
    .select({ orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, auth.runId), eq(agentRuns.userId, auth.userId)))
    .limit(1);

  if (!run) {
    log.warn(`[${auth.runId}] Run not found for token refresh`);
    return null;
  }

  const connectorTypes = [...new Set(refreshable.values())];
  const expiryMap = await getConnectorExpiry(
    run.orgId,
    auth.userId,
    connectorTypes,
  );

  const now = Math.floor(Date.now() / 1000);
  const REFRESH_BUFFER_SECS = 60;

  // Refresh tokens that are expired or expiring within the buffer window (parallel)
  const toRefresh = connectorTypes.filter((ct) => {
    const tokenExpiry = expiryMap.get(ct);
    return (
      tokenExpiry !== undefined &&
      tokenExpiry !== null &&
      tokenExpiry <= now + REFRESH_BUFFER_SECS
    );
  });

  const results = await Promise.all(
    toRefresh.map(async (connectorType) => {
      log.debug(`[${auth.runId}] Refreshing expired ${connectorType} token`);
      const freshToken = await refreshConnectorAccessToken(
        connectorType,
        run.orgId,
        auth.userId,
        secrets,
      );
      if (!freshToken) {
        log.warn(
          `[${auth.runId}] Failed to refresh ${connectorType} token, using existing`,
        );
      }
      return !!freshToken;
    }),
  );
  const refreshed = results.some(Boolean);

  // Use accurate DB values after refresh; skip extra query if nothing changed
  const finalExpiryMap = refreshed
    ? await getConnectorExpiry(run.orgId, auth.userId, connectorTypes)
    : expiryMap;

  let earliestExpiry: number | null = null;
  for (const connectorType of connectorTypes) {
    const expiry = finalExpiryMap.get(connectorType);
    if (expiry !== undefined && expiry !== null) {
      earliestExpiry =
        earliestExpiry === null ? expiry : Math.min(earliestExpiry, expiry);
    }
  }

  return earliestExpiry;
}

/**
 * Resolve ${secrets.XXX} templates with decrypted secret values.
 */
function resolveTemplates(
  authHeaders: Record<string, string>,
  secrets: Record<string, string>,
  runId: string,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, template] of Object.entries(authHeaders)) {
    resolved[name] = template.replace(
      SECRET_TEMPLATE_RE,
      (_match, key: string) => {
        if (!(key in secrets)) {
          log.warn(`[${runId}] No secret value for "${key}" in template`);
          return "";
        }
        return secrets[key] ?? "";
      },
    );
  }
  return resolved;
}

/**
 * POST /api/webhooks/agent/services/auth
 *
 * Decrypter/template resolver for service auth headers.
 * Called by the mitmproxy addon when it intercepts a service-matched request.
 *
 * When secretConnectorMap is provided, expired OAuth tokens are refreshed
 * on demand and an expiresAt timestamp is returned for addon-side TTL caching.
 *
 * Auth: Sandbox JWT
 * Body: { encryptedSecrets, authHeaders, secretConnectorMap? }
 * Response: { headers, expiresAt? }
 */
export async function POST(request: Request) {
  initServices();

  // Authenticate via sandbox JWT
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return NextResponse.json(
      { error: { message: "Missing authorization", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const auth = verifySandboxToken(token);
  if (!auth) {
    return NextResponse.json(
      { error: { message: "Invalid token", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  // Parse request body
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { message: "Invalid JSON body", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          message: "encryptedSecrets and authHeaders are required",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }
  const { encryptedSecrets, authHeaders, secretConnectorMap } = parsed.data;

  // Decrypt secrets
  let secrets: Record<string, string> | null;
  try {
    secrets = decryptSecretsMap(
      encryptedSecrets,
      globalThis.services.env.SECRETS_ENCRYPTION_KEY,
    );
  } catch {
    secrets = null;
  }
  if (!secrets) {
    return NextResponse.json(
      { error: { message: "Failed to decrypt secrets", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  // Collect which secret keys are referenced in auth templates
  const referencedKeys = new Set<string>();
  for (const template of Object.values(authHeaders)) {
    for (const match of template.matchAll(SECRET_TEMPLATE_RE)) {
      if (match[1]) referencedKeys.add(match[1]);
    }
  }

  // Refresh expired OAuth tokens (mutates secrets map with fresh values)
  let expiresAt: number | null = null;
  if (secretConnectorMap) {
    expiresAt = await refreshExpiredTokens(
      auth,
      secrets,
      secretConnectorMap,
      referencedKeys,
    );
  }

  // Resolve templates with (possibly refreshed) secret values
  const headers = resolveTemplates(authHeaders, secrets, auth.runId);

  return NextResponse.json({ headers, expiresAt });
}
