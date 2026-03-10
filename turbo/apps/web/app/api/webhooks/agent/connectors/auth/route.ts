import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import {
  connectorTypeSchema,
  getConnectorEnvironmentMapping,
  getConnectorProxyConfig,
} from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { getSandboxAuthForRun } from "../../../../../../src/lib/auth/get-sandbox-auth";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { connectors } from "../../../../../../src/db/schema/connector";
import { getSecretValues } from "../../../../../../src/lib/secret/secret-service";
import { upsertConnectorSecret } from "../../../../../../src/lib/connector/connector-service";
import { PROVIDER_HANDLERS } from "../../../../../../src/lib/connector/provider-registry";
import { logger } from "../../../../../../src/lib/logger";

const bodySchema = z.object({
  runId: z.string(),
  connectorName: z.string(),
  base: z.string(),
});

const log = logger("webhook:connector-token");

type ProviderHandler =
  (typeof PROVIDER_HANDLERS)[keyof typeof PROVIDER_HANDLERS];

/**
 * Attempt to refresh the connector's access token if the handler supports it.
 * Returns an error response if refresh fails, or null on success/skip.
 */
async function refreshConnectorToken(
  handler: ProviderHandler,
  connectorType: string,
  connectorSecrets: Record<string, string>,
  accessTokenName: string,
  scopeId: string,
  userId: string,
  clerkOrgId: string,
  runId: string,
): Promise<Response | null> {
  if (!handler.refreshToken || !handler.getRefreshSecretName) return null;

  const refreshTokenName = handler.getRefreshSecretName();
  const currentRefreshToken = connectorSecrets[refreshTokenName];
  if (!currentRefreshToken) return null;

  const env = globalThis.services.env;
  const clientId = handler.getClientId(env);
  const clientSecret = handler.getClientSecret(env);

  if (!clientId || !clientSecret) {
    log.error(
      `Missing OAuth credentials for "${connectorType}" — check env config`,
    );
    return NextResponse.json(
      {
        error: {
          message: `OAuth configuration missing for "${connectorType}"`,
          code: "CONFIG_ERROR",
        },
      },
      { status: 500 },
    );
  }

  try {
    const result = await handler.refreshToken(
      clientId,
      clientSecret,
      currentRefreshToken,
    );
    await upsertConnectorSecret(
      scopeId,
      userId,
      accessTokenName,
      result.accessToken,
      clerkOrgId,
    );
    if (result.refreshToken) {
      await upsertConnectorSecret(
        scopeId,
        userId,
        refreshTokenName,
        result.refreshToken,
        clerkOrgId,
      );
    }
    connectorSecrets[accessTokenName] = result.accessToken;
    log.debug(`Refreshed ${connectorType} token for run ${runId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error(`${connectorType} token refresh failed: ${message}`);
    return NextResponse.json(
      {
        error: {
          message: `Token refresh failed for "${connectorType}"`,
          code: "TOKEN_REFRESH_FAILED",
        },
      },
      { status: 502 },
    );
  }

  return null;
}

/**
 * Resolve `${secrets.XXX}` references in auth header templates using
 * the connector's environmentMapping and real secret values.
 */
function resolveAuthHeaders(
  templates: Record<string, string>,
  envMapping: Record<string, string>,
  connectorSecrets: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [headerName, template] of Object.entries(templates)) {
    resolved[headerName] = template.replace(
      /\$\{secrets\.([^}]+)\}/g,
      (_match, envKey: string) => {
        const secretRef = envMapping[envKey];
        if (!secretRef) {
          log.warn(`No environment mapping for "${envKey}"`);
          return "";
        }
        const internalName = secretRef.startsWith("$secrets.")
          ? secretRef.slice("$secrets.".length)
          : secretRef;
        const value = connectorSecrets[internalName];
        if (!value) {
          log.warn(`No secret value for "${internalName}"`);
          return "";
        }
        return value;
      },
    );
  }
  return resolved;
}

/**
 * POST /api/webhooks/agent/connectors/auth
 *
 * Returns resolved auth headers for a connector.
 * Called by the mitmproxy addon when it intercepts a connector-matched request.
 *
 * Auth: Sandbox JWT (same as other webhook/agent endpoints).
 * Body: { runId: string, connectorName: string, base: string }
 * Response: { headers: Record<string, string>, expiresIn: number }
 */
export async function POST(request: Request) {
  initServices();

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid JSON body",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          message: "runId and connectorName are required",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // Authenticate via sandbox JWT
  const auth = getSandboxAuthForRun(
    body.runId,
    request.headers.get("Authorization") ?? undefined,
  );
  if (!auth) {
    return NextResponse.json(
      {
        error: {
          message: "Not authenticated or runId mismatch",
          code: "UNAUTHORIZED",
        },
      },
      { status: 401 },
    );
  }

  // Validate connector type
  const connectorParsed = connectorTypeSchema.safeParse(body.connectorName);
  if (!connectorParsed.success) {
    return NextResponse.json(
      {
        error: {
          message: `Unknown connector type: "${body.connectorName}"`,
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }
  const connectorType = connectorParsed.data;

  // Get proxy config (auth header templates)
  const proxyConfig = getConnectorProxyConfig(connectorType);
  if (!proxyConfig) {
    return NextResponse.json(
      {
        error: {
          message: `No proxy config for "${connectorType}"`,
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  // Look up run to get scopeId
  const [run] = await globalThis.services.db
    .select({ scopeId: agentRuns.scopeId, clerkOrgId: agentRuns.clerkOrgId })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, auth.userId)))
    .limit(1);

  if (!run) {
    return NextResponse.json(
      { error: { message: "Agent run not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Verify connector is connected
  const [connector] = await globalThis.services.db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.scopeId, run.scopeId),
        eq(connectors.userId, auth.userId),
        eq(connectors.type, connectorType),
      ),
    )
    .limit(1);

  if (!connector) {
    return NextResponse.json(
      {
        error: {
          message: `Connector "${connectorType}" is not connected`,
          code: "NOT_FOUND",
        },
      },
      { status: 404 },
    );
  }

  // Get connector secrets and refresh if needed
  const connectorSecrets = await getSecretValues(
    run.scopeId,
    auth.userId,
    "connector",
  );
  const handler =
    connectorType in PROVIDER_HANDLERS
      ? PROVIDER_HANDLERS[connectorType as keyof typeof PROVIDER_HANDLERS]
      : undefined;

  if (handler) {
    const accessTokenName = handler.getSecretName();
    const refreshError = await refreshConnectorToken(
      handler,
      connectorType,
      connectorSecrets,
      accessTokenName,
      run.scopeId,
      auth.userId,
      run.clerkOrgId,
      body.runId,
    );
    if (refreshError) return refreshError;
  }

  // Find the matching service by base URL
  const matchedService = proxyConfig.services.find(
    (svc) => svc.base === body.base,
  );
  if (!matchedService) {
    return NextResponse.json(
      {
        error: {
          message: `No service matching base "${body.base}" for connector "${connectorType}"`,
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  // Resolve auth header templates with real secret values
  const envMapping = getConnectorEnvironmentMapping(connectorType);
  const resolvedHeaders = resolveAuthHeaders(
    matchedService.auth.headers,
    envMapping,
    connectorSecrets,
  );

  // Check that at least one header was resolved to a non-empty value
  const hasToken = Object.values(resolvedHeaders).some((v) => v.length > 0);
  if (!hasToken) {
    return NextResponse.json(
      {
        error: {
          message: `No secrets found for "${connectorType}"`,
          code: "NOT_FOUND",
        },
      },
      { status: 404 },
    );
  }

  // Default TTL: 1 hour (headers are cached by addon, refreshed on 401)
  return NextResponse.json({ headers: resolvedHeaders, expiresIn: 3600 });
}
