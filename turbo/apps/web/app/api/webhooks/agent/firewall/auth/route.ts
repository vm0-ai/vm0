import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifySandboxToken } from "../../../../../../src/lib/auth/sandbox-token";
import type { SandboxAuth } from "../../../../../../src/lib/auth/sandbox-token";
import { decryptSecretsMap } from "../../../../../../src/lib/shared/crypto/secrets-encryption";
import { logger } from "../../../../../../src/lib/shared/logger";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import {
  refreshConnectorAccessToken,
  getConnectorExpiry,
  getConnectorAccessToken,
  getConnectorRefreshToken,
} from "../../../../../../src/lib/zero/connector/connector-service";
import { basicAuthTemplateRe } from "@vm0/core";

const bodySchema = z.object({
  encryptedSecrets: z.string().min(1),
  authHeaders: z.record(z.string(), z.string()),
  authBase: z.string().optional(),
  authQuery: z.record(z.string(), z.string()).optional(),
  secretConnectorMap: z.record(z.string(), z.string()).optional(),
  vars: z.record(z.string(), z.string()).optional(),
});

const log = logger("webhook:firewall-auth");

/** Matches ${{ secrets.X }} or ${{ vars.X }} template placeholders. */
const TEMPLATE_RE = /\$\{\{\s*(secrets|vars)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Refresh tokens whose expiry falls within this buffer to avoid serving a
 * token that expires mid-request. Chosen to absorb network latency + clock
 * skew between our server and the OAuth provider.
 */
const REFRESH_BUFFER_SECS = 60;

/**
 * Load refresh tokens from DB into the secrets map.
 * The encrypted secrets snapshot only contains mapped env vars (access tokens);
 * refresh tokens are kept server-side and must be fetched from DB (#7365).
 * Mutates `secrets` in place.
 */
async function syncRefreshTokensFromDb(
  connectorTypes: string[],
  orgId: string,
  userId: string,
  secrets: Record<string, string>,
): Promise<void> {
  if (connectorTypes.length === 0) return;
  const results = await Promise.all(
    connectorTypes.map((ct) => {
      return getConnectorRefreshToken(ct, orgId, userId);
    }),
  );
  for (const result of results) {
    if (result) {
      secrets[result.secretName] = result.token;
    }
  }
}

/**
 * Refresh expired OAuth tokens referenced by auth templates.
 * Mutates `secrets` in place with fresh token values.
 */
interface RefreshResult {
  expiresAt: number | null;
  refreshedConnectors: string[];
  refreshedSecrets: string[];
  failedConnectors: string[];
}

async function refreshExpiredTokens(
  auth: SandboxAuth,
  secrets: Record<string, string>,
  secretConnectorMap: Record<string, string>,
  referencedKeys: Set<string>,
): Promise<RefreshResult> {
  // Find which referenced secrets are refreshable OAuth tokens
  const refreshable = new Map<string, string>();
  for (const key of referencedKeys) {
    const connectorType = secretConnectorMap[key];
    if (connectorType) refreshable.set(key, connectorType);
  }
  if (refreshable.size === 0)
    return {
      expiresAt: null,
      refreshedConnectors: [],
      refreshedSecrets: [],
      failedConnectors: [],
    };

  // Look up orgId from runId
  const [run] = await globalThis.services.db
    .select({ orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, auth.runId), eq(agentRuns.userId, auth.userId)))
    .limit(1);

  if (!run) {
    log.warn(`[${auth.runId}] Run not found for token refresh`);
    return {
      expiresAt: null,
      refreshedConnectors: [],
      refreshedSecrets: [],
      failedConnectors: [],
    };
  }

  const connectorTypes = [...new Set(refreshable.values())];
  const expiryMap = await getConnectorExpiry(
    run.orgId,
    auth.userId,
    connectorTypes,
  );

  const now = Math.floor(Date.now() / 1000);

  // Refresh tokens that are expired or expiring within the buffer window (parallel).
  // null/undefined expiry means we don't know when the token expires — treat as
  // "needs refresh" so we backfill tokenExpiresAt. All connectors reaching this
  // filter are refreshable OAuth (pre-filtered in resolve-connectors.ts), so
  // their access tokens DO expire by definition. See #9836.
  const toRefresh = connectorTypes.filter((ct) => {
    const tokenExpiry = expiryMap.get(ct);
    if (tokenExpiry === undefined || tokenExpiry === null) return true;
    return tokenExpiry <= now + REFRESH_BUFFER_SECS;
  });

  // Build reverse map: connectorType → [envVarNames that reference its token]
  // so we can sync mapped env var values after refresh.
  const envVarsByConnector = new Map<string, string[]>();
  for (const [envVar, ct] of refreshable) {
    const arr = envVarsByConnector.get(ct) ?? [];
    arr.push(envVar);
    envVarsByConnector.set(ct, arr);
  }

  // Load refresh tokens from DB into secrets before refreshing.
  // The encrypted secrets snapshot only contains mapped env vars (access tokens),
  // not refresh tokens — refresh tokens are kept server-side only (#7365).
  await syncRefreshTokensFromDb(toRefresh, run.orgId, auth.userId, secrets);

  const refreshResults = await Promise.all(
    toRefresh.map(async (connectorType) => {
      log.debug(`[${auth.runId}] Refreshing expired ${connectorType} token`);
      const freshToken = await refreshConnectorAccessToken(
        connectorType,
        run.orgId,
        auth.userId,
        secrets,
      );
      if (!freshToken) {
        log.warn(`[${auth.runId}] Failed to refresh ${connectorType} token`);
        return { connectorType, ok: false as const };
      }
      // refreshConnectorAccessToken updates secrets[rawSecretName] but the
      // template may reference a mapped env var name.  Sync all mapped keys
      // so resolveTemplates picks up the fresh token.
      for (const envVar of envVarsByConnector.get(connectorType) ?? []) {
        secrets[envVar] = freshToken;
      }
      return { connectorType, ok: true as const };
    }),
  );
  // For connector types we did NOT refresh (DB says token is still valid),
  // read the current token from the secrets store. This fixes a race condition
  // where another concurrent request just refreshed the token — the DB expiry
  // looks fresh but encryptedSecrets still has the stale build-time value.
  const toRefreshSet = new Set(toRefresh);
  const skippedTypes = connectorTypes.filter((ct) => {
    return !toRefreshSet.has(ct);
  });
  if (skippedTypes.length > 0) {
    const currentTokens = await Promise.all(
      skippedTypes.map(async (ct) => {
        return {
          connectorType: ct,
          token: await getConnectorAccessToken(ct, run.orgId, auth.userId),
        };
      }),
    );
    for (const { connectorType, token } of currentTokens) {
      if (!token) {
        log.warn(
          `[${auth.runId}] No DB token for skipped connector ${connectorType}, using encryptedSecrets value`,
        );
        continue;
      }
      for (const envVar of envVarsByConnector.get(connectorType) ?? []) {
        secrets[envVar] = token;
      }
    }
  }

  const refreshedConnectors = refreshResults
    .filter((r) => {
      return r.ok;
    })
    .map((r) => {
      return r.connectorType;
    });
  const refreshed = refreshedConnectors.length > 0;
  // Map refreshed connector types back to their secret key names
  const refreshedSecrets = refreshedConnectors
    .flatMap((ct) => {
      return envVarsByConnector.get(ct) ?? [];
    })
    .sort();
  const failedConnectors = refreshResults
    .filter((r) => {
      return !r.ok;
    })
    .map((r) => {
      return r.connectorType;
    });

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

  return {
    expiresAt: earliestExpiry,
    refreshedConnectors,
    refreshedSecrets,
    failedConnectors,
  };
}

/** Collect all secret and var keys referenced in auth header/base/query templates (simple + basic). */
function collectReferencedKeys(
  authHeaders: Record<string, string>,
  authBase?: string,
  authQuery?: Record<string, string>,
): { secrets: Set<string>; vars: Set<string> } {
  const secrets = new Set<string>();
  const vars = new Set<string>();
  const addKey = (namespace: string, key: string) => {
    if (namespace === "secrets") secrets.add(key);
    else if (namespace === "vars") vars.add(key);
  };
  for (const template of Object.values(authHeaders)) {
    for (const match of template.matchAll(TEMPLATE_RE)) {
      if (match[1] && match[2]) addKey(match[1], match[2]);
    }
    for (const match of template.matchAll(basicAuthTemplateRe())) {
      // Groups per side: (ns, key, literal). Only ns.key references need
      // to be tracked; literals are baked into the template itself.
      if (match[1] && match[2]) addKey(match[1], match[2]);
      if (match[4] && match[5]) addKey(match[4], match[5]);
    }
  }
  if (authBase) {
    for (const match of authBase.matchAll(TEMPLATE_RE)) {
      if (match[1] && match[2]) addKey(match[1], match[2]);
    }
  }
  if (authQuery) {
    for (const template of Object.values(authQuery)) {
      for (const match of template.matchAll(TEMPLATE_RE)) {
        if (match[1] && match[2]) addKey(match[1], match[2]);
      }
    }
  }
  return { secrets, vars };
}

/**
 * Resolve a single basic() argument slot.
 * Arg can be: secrets.X, vars.X, "literal", or omitted.
 * Returns the resolved value, or empty string if the slot is omitted/missing.
 */
function resolveBasicArg(
  namespace: string | undefined,
  key: string | undefined,
  literal: string | undefined,
  secrets: Record<string, string>,
  vars: Record<string, string>,
  resolvedKeys: Set<string>,
): string {
  if (literal !== undefined) return literal;
  if (!namespace || !key) return "";
  if (namespace === "secrets") {
    resolvedKeys.add(key);
    return secrets[key] ?? "";
  }
  return vars[key] ?? "";
}

/**
 * Resolve ${{ secrets.XXX }}, ${{ vars.XXX }}, and ${{ basic(...) }} templates
 * in auth header values, optional auth base URL, and optional auth query params.
 */
function resolveTemplates(
  authHeaders: Record<string, string>,
  secrets: Record<string, string>,
  vars: Record<string, string>,
  authBase?: string,
  authQuery?: Record<string, string>,
): {
  headers: Record<string, string>;
  resolvedSecrets: string[];
  base?: string;
  query?: Record<string, string>;
} {
  const resolvedKeys = new Set<string>();

  const resolveSimple = (template: string): string => {
    return template.replace(
      TEMPLATE_RE,
      (_match, namespace: string, key: string) => {
        if (namespace === "secrets") {
          resolvedKeys.add(key);
          return secrets[key] ?? "";
        }
        return vars[key] ?? "";
      },
    );
  };

  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(authHeaders)) {
    // Pass 1: resolve ${{ basic(username, password) }} templates FIRST,
    // so string literals inside basic() are not subject to further
    // template resolution (e.g. `basic("${{ secrets.X }}", ...)` keeps
    // the literal as-is rather than interpolating the secret). The
    // output is a Basic <base64> header — base64 charset has no `$`,
    // so Pass 2 cannot match inside basic()'s output.
    let resolved = template.replace(
      basicAuthTemplateRe(),
      (
        _match,
        ns1?: string,
        key1?: string,
        lit1?: string,
        ns2?: string,
        key2?: string,
        lit2?: string,
      ) => {
        const user = resolveBasicArg(
          ns1,
          key1,
          lit1,
          secrets,
          vars,
          resolvedKeys,
        );
        const pass = resolveBasicArg(
          ns2,
          key2,
          lit2,
          secrets,
          vars,
          resolvedKeys,
        );
        return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
      },
    );
    // Pass 2: resolve simple ${{ secrets.X }} and ${{ vars.X }} templates
    resolved = resolveSimple(resolved);
    headers[name] = resolved;
  }

  // Resolve auth base URL template
  const resolvedBase = authBase ? resolveSimple(authBase) : undefined;

  // Resolve auth query param templates
  const resolvedQuery = authQuery
    ? Object.fromEntries(
        Object.entries(authQuery).map(([k, v]) => {
          return [k, resolveSimple(v)];
        }),
      )
    : undefined;

  return {
    headers,
    resolvedSecrets: [...resolvedKeys].sort(),
    base: resolvedBase,
    query: resolvedQuery,
  };
}

/**
 * POST /api/webhooks/agent/firewall/auth
 *
 * Decrypter/template resolver for firewall auth headers.
 * Called by the mitmproxy addon when it intercepts a firewall-matched request.
 *
 * When secretConnectorMap is provided, expired OAuth tokens are refreshed
 * on demand and an expiresAt timestamp is returned for addon-side TTL caching.
 *
 * Auth: Sandbox JWT
 * Body: { encryptedSecrets, authHeaders, authBase?, authQuery?, secretConnectorMap?, vars? }
 * Response: { headers, base?, query?, expiresAt?, resolvedSecrets, refreshedConnectors, refreshedSecrets }
 *           or 424 { error } when referenced secrets/vars are missing (connector not configured)
 *           or 502 { error } when token refresh fails
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
  const {
    encryptedSecrets,
    authHeaders,
    authBase,
    authQuery,
    secretConnectorMap,
    vars,
  } = parsed.data;

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

  // Collect which secret and var keys are referenced in auth templates
  const referenced = collectReferencedKeys(authHeaders, authBase, authQuery);

  // Check that all referenced secrets and vars exist.
  // Missing secrets indicate the connector is enabled but not linked.
  // Missing vars indicate incomplete connector configuration.
  const hasMissingSecrets = [...referenced.secrets].some((key) => {
    return !(key in secrets);
  });
  const hasMissingVars = [...referenced.vars].some((key) => {
    return !(key in (vars ?? {}));
  });
  if (hasMissingSecrets || hasMissingVars) {
    return NextResponse.json(
      {
        error: {
          message: "Connector not configured",
          code: "CONNECTOR_NOT_CONFIGURED",
        },
      },
      { status: 424 },
    );
  }

  // Refresh expired OAuth tokens (mutates secrets map with fresh values)
  let expiresAt: number | null = null;
  let refreshedConnectors: string[] = [];
  let refreshedSecrets: string[] = [];
  let failedConnectors: string[] = [];
  if (secretConnectorMap) {
    const result = await refreshExpiredTokens(
      auth,
      secrets,
      secretConnectorMap,
      referenced.secrets,
    );
    expiresAt = result.expiresAt;
    refreshedConnectors = result.refreshedConnectors;
    refreshedSecrets = result.refreshedSecrets;
    failedConnectors = result.failedConnectors;
  }

  // If any connector token refresh failed, return an error so the addon
  // surfaces a clear message instead of silently using a stale token.
  if (failedConnectors.length > 0) {
    return NextResponse.json(
      {
        error: {
          message: `OAuth token expired and refresh failed for: ${failedConnectors.join(", ")}. The connector may need to be reconnected.`,
          code: "TOKEN_REFRESH_FAILED",
          connectors: failedConnectors,
        },
      },
      { status: 502 },
    );
  }

  // Resolve templates with (possibly refreshed) secret values
  const { headers, resolvedSecrets, base, query } = resolveTemplates(
    authHeaders,
    secrets,
    vars ?? {},
    authBase,
    authQuery,
  );

  return NextResponse.json({
    headers,
    base,
    query,
    expiresAt,
    resolvedSecrets,
    refreshedConnectors,
    refreshedSecrets,
  });
}
