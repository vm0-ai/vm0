import { NextResponse } from "next/server";
import {
  connectorTypeSchema,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { env } from "../../../../../src/env";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { getOrigin } from "../../../../../src/lib/shared/request/get-origin";
import {
  type AuthUrlResult,
  PROVIDER_HANDLERS,
  providerEnvFromObject,
} from "@vm0/connectors/oauth-providers";
import {
  getConnectorOAuthCredentials,
  getConnectorOAuthStorage,
} from "@vm0/connectors/connector-utils";
import { deleteConnector } from "../../../../../src/lib/zero/connector/connector-service";
import { logger } from "../../../../../src/lib/shared/logger";
import { and, eq } from "drizzle-orm";
import { connectors } from "@vm0/db/schema/connector";

const log = logger("api:connectors:authorize");

/**
 * Connector OAuth Authorize Endpoint
 *
 * GET /api/connectors/:type/authorize
 *
 * Redirects users to the OAuth provider's authorization page
 */

// Cookie names for OAuth state, session, and PKCE
const STATE_COOKIE_NAME = "connector_oauth_state";
const SESSION_COOKIE_NAME = "connector_oauth_session";
const PKCE_COOKIE_NAME = "connector_oauth_pkce";
const OAUTH_CONTEXT_COOKIE_NAME = "connector_oauth_context";
const COOKIE_MAX_AGE = 15 * 60; // 15 minutes

type BrowserOAuthConnectorType = Exclude<ConnectorType, "computer">;

/**
 * Generate a random state string for CSRF protection
 */
function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => {
    return b.toString(16).padStart(2, "0");
  }).join("");
}

/**
 * Build Set-Cookie header value
 */
function buildCookieHeader(
  name: string,
  value: string,
  maxAge: number,
): string {
  const parts = [
    `${name}=${value}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (env().NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function connectorOAuthAuthorizationError(
  connectorType: BrowserOAuthConnectorType,
): string {
  if (connectorType === "codex-oauth") {
    return "codex-oauth does not use browser OAuth authorization; use the codex auth.json paste flow";
  }
  return `${connectorType} does not use connector OAuth authorization`;
}

function rejectUnsupportedConnectorOAuth(
  connectorType: BrowserOAuthConnectorType,
): NextResponse | undefined {
  const oauthStorage = getConnectorOAuthStorage(connectorType);
  if (!oauthStorage) {
    return NextResponse.json(
      { error: `${connectorType} connector does not use OAuth` },
      { status: 400 },
    );
  }

  if (oauthStorage !== "connector") {
    return NextResponse.json(
      { error: connectorOAuthAuthorizationError(connectorType) },
      { status: 400 },
    );
  }

  return undefined;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ type: string }> },
) {
  initServices();

  const { type } = await params;

  // Validate connector type
  const typeResult = connectorTypeSchema.safeParse(type);
  if (!typeResult.success) {
    return NextResponse.json(
      { error: `Unknown connector type: ${type}` },
      { status: 400 },
    );
  }
  const connectorType = typeResult.data;

  // Resolve origin early (handles forwarded host behind proxy/tunnel)
  const url = new URL(request.url);
  const origin = getOrigin(request);

  // Verify user is authenticated
  const authHeader = request.headers.get("authorization") ?? undefined;
  const authCtx = await getAuthContext(authHeader);
  if (!authCtx) {
    // Redirect to login page using correct origin (not localhost behind tunnel)
    const loginUrl = new URL("/sign-in", origin);
    const authorizeUrl = new URL(url.pathname + url.search, origin);
    loginUrl.searchParams.set("redirect_url", authorizeUrl.toString());
    return NextResponse.redirect(loginUrl.toString());
  }

  // Computer connector does not use OAuth
  if (connectorType === "computer") {
    return NextResponse.json(
      { error: "Computer connector does not use OAuth" },
      { status: 400 },
    );
  }

  const unsupportedOAuthResponse =
    rejectUnsupportedConnectorOAuth(connectorType);
  if (unsupportedOAuthResponse) {
    return unsupportedOAuthResponse;
  }

  // Auto-disconnect existing connector before re-authorizing.
  // This ensures old provider tokens are revoked during reconnect flows
  // (both "Connection expired" and "Permissions update" paths).
  const { org } = await resolveOrg(authCtx);

  const [existing] = await globalThis.services.db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, org.orgId),
        eq(connectors.userId, authCtx.userId),
        eq(connectors.type, connectorType),
      ),
    )
    .limit(1);

  if (existing) {
    log.info("Auto-disconnecting existing connector before re-authorize", {
      type: connectorType,
      userId: authCtx.userId,
    });
    await deleteConnector(org.orgId, authCtx.userId, connectorType);
  }

  // Generate state for CSRF protection
  const state = generateState();

  // Build redirect URI
  const redirectUri = `${origin}/api/connectors/${type}/callback`;

  // Check for session parameter (CLI device flow)
  const sessionId = url.searchParams.get("session");

  // Build authorization URL via provider registry
  const currentEnv = providerEnvFromObject(env());
  const handler = PROVIDER_HANDLERS[connectorType];
  const credentials = getConnectorOAuthCredentials(
    connectorType,
    (name) => {
      return currentEnv[name];
    },
    { requireClientSecret: false },
  );
  if (!credentials?.configured) {
    return NextResponse.json(
      { error: `${connectorType} OAuth not configured` },
      { status: 500 },
    );
  }
  const authResult =
    credentials.client?.clientRegistration === "dynamic"
      ? await handler.buildAuthUrlWithoutClient?.(redirectUri, state)
      : credentials.clientId
        ? await handler.buildAuthUrl(credentials.clientId, redirectUri, state)
        : undefined;
  if (!authResult) {
    return NextResponse.json(
      { error: `${connectorType} OAuth not configured` },
      { status: 500 },
    );
  }

  // Normalize result — handlers may return a plain URL string or { url, codeVerifier }
  const isAuthUrlResult = (v: string | AuthUrlResult): v is AuthUrlResult => {
    return typeof v === "object" && "url" in v;
  };
  const authUrl = isAuthUrlResult(authResult) ? authResult.url : authResult;
  const codeVerifier = isAuthUrlResult(authResult)
    ? authResult.codeVerifier
    : undefined;
  const oauthContext = isAuthUrlResult(authResult)
    ? authResult.oauthContext
    : undefined;

  // Create redirect response with state cookie
  const response = NextResponse.redirect(authUrl);
  response.headers.append(
    "Set-Cookie",
    buildCookieHeader(STATE_COOKIE_NAME, state, COOKIE_MAX_AGE),
  );

  // If PKCE code_verifier was generated, store it in a cookie for the callback
  if (codeVerifier) {
    response.headers.append(
      "Set-Cookie",
      buildCookieHeader(PKCE_COOKIE_NAME, codeVerifier, COOKIE_MAX_AGE),
    );
  }

  if (oauthContext) {
    response.headers.append(
      "Set-Cookie",
      buildCookieHeader(
        OAUTH_CONTEXT_COOKIE_NAME,
        oauthContext,
        COOKIE_MAX_AGE,
      ),
    );
  }

  // If session ID provided, store it in a cookie for the callback
  if (sessionId) {
    response.headers.append(
      "Set-Cookie",
      buildCookieHeader(SESSION_COOKIE_NAME, sessionId, COOKIE_MAX_AGE),
    );
  }

  return response;
}
