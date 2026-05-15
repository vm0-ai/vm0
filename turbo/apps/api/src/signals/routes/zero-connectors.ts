import { randomInt } from "node:crypto";

import { command, computed } from "ccstate";
import type { AppRoute } from "@ts-rest/core";
import {
  zeroComputerConnectorContract,
  zeroConnectorAuthorizeContract,
  zeroConnectorSessionsContract,
  zeroConnectorSessionByIdContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
  zeroConnectorsSearchContract,
  zeroLocalBrowserConnectorContract,
  zeroRemoteAgentConnectorContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  getConnectorAuthMethods,
  getConnectorOAuthConfig,
  getConnectorOAuthEnvKeys,
  isGoogleOAuthConnector,
} from "@vm0/connectors/connector-utils";
import {
  connectorTypeSchema,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { connectorSessions } from "@vm0/db/schema/connector-session";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import {
  authContext$,
  organizationAuthContext$,
  requiredAuthContext$,
} from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { pathParamsOf, queryOf } from "../context/request";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { env, optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  deleteComputerConnector$,
  deleteZeroConnectorLocalState$,
  zeroConnectorByType,
  zeroConnectorList,
  zeroConnectorScopeDiff,
  zeroConnectorSearch,
} from "../services/zero-connector-data.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { connectLocalBrowserConnector$ } from "../services/zero-local-browser.service";
import { connectRemoteAgentConnector$ } from "../services/zero-remote-agent.service";
import { createComputerConnector$ } from "../services/zero-computer-connector.service";
import type { RouteEntry } from "../route";

const STATE_COOKIE_NAME = "connector_oauth_state";
const SESSION_COOKIE_NAME = "connector_oauth_session";
const PKCE_COOKIE_NAME = "connector_oauth_pkce";
const COOKIE_MAX_AGE = 15 * 60;
const REDIRECT_STATUS = 307;
const CONNECTOR_SESSION_TTL_SECONDS = 15 * 60;
const CONNECTOR_SESSION_POLL_INTERVAL_SECONDS = 5;
const CONNECTOR_SESSION_CODE_LENGTH = 8;
const CONNECTOR_SESSION_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

type ConnectorAuthorizeRoute = AppRoute & {
  readonly pathParams: z.ZodType<{ readonly type: string }>;
  readonly query: z.ZodType<{ readonly session?: string }>;
};

const connectorReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:read",
} as const;

const connectorWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const localBrowserDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Local browser use is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

function isLocalBrowserEnabled(params: {
  readonly orgId: string;
  readonly userId: string;
  readonly overrides: Record<string, boolean>;
}): boolean {
  return isFeatureEnabled(FeatureSwitchKey.LocalBrowserUse, {
    orgId: params.orgId,
    userId: params.userId,
    overrides: params.overrides,
  });
}

function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

function generateConnectorSessionCode(
  length: number = CONNECTOR_SESSION_CODE_LENGTH,
): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    if (i > 0 && i % 4 === 0) {
      code += "-";
    }
    code +=
      CONNECTOR_SESSION_CODE_CHARS[
        randomInt(CONNECTOR_SESSION_CODE_CHARS.length)
      ];
  }
  return code;
}

function isRefreshOnlyConnectorType(type: ConnectorType): boolean {
  return type === "codex-oauth";
}

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
  if (env("ENV") === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function getRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedHost) {
    return `${forwardedProto ?? "https"}://${forwardedHost}`;
  }
  return url.origin;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

async function base64UrlSha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(hash).toString("base64url");
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Buffer.from(array).toString("base64url");
}

function codeChallenge(codeVerifier: string): Promise<string> {
  return base64UrlSha256(codeVerifier);
}

function deterministicPkceSuffix(type: ConnectorType): string | undefined {
  switch (type) {
    case "canva": {
      return "canva-pkce-verifier";
    }
    case "deel": {
      return "deel-pkce-verifier";
    }
    case "docusign": {
      return "docusign-pkce-verifier";
    }
    case "garmin-connect": {
      return "garmin-pkce-verifier";
    }
    case "supabase": {
      return "supabase-pkce-verifier";
    }
    case "x": {
      return "x-pkce-verifier";
    }
    default: {
      return undefined;
    }
  }
}

async function buildAuthorizeUrl(args: {
  readonly type: ConnectorType;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
}): Promise<{ readonly url: string; readonly codeVerifier?: string } | null> {
  const oauthConfig = getConnectorOAuthConfig(args.type);
  if (!oauthConfig?.authorizationUrl) {
    return null;
  }

  if (args.type === "github") {
    return {
      url: `${oauthConfig.authorizationUrl}?${new URLSearchParams({
        client_id: args.clientId,
        redirect_uri: args.redirectUri,
        scope: oauthConfig.scopes.join(" "),
        state: args.state,
      }).toString()}`,
    };
  }

  if (args.type === "slack") {
    return {
      url: `${oauthConfig.authorizationUrl}?${new URLSearchParams({
        client_id: args.clientId,
        redirect_uri: args.redirectUri,
        user_scope: oauthConfig.scopes.join(","),
        state: args.state,
      }).toString()}`,
    };
  }

  if (args.type === "notion") {
    return {
      url: `${oauthConfig.authorizationUrl}?${new URLSearchParams({
        client_id: args.clientId,
        redirect_uri: args.redirectUri,
        state: args.state,
        response_type: "code",
        owner: "user",
      }).toString()}`,
    };
  }

  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    state: args.state,
  });
  if (oauthConfig.scopes.length > 0 && args.type !== "garmin-connect") {
    const scopeSeparator =
      args.type === "linear" || args.type === "strava" ? "," : " ";
    params.set("scope", oauthConfig.scopes.join(scopeSeparator));
  }
  if (isGoogleOAuthConnector(args.type)) {
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  }
  if (args.type === "outlook-calendar" || args.type === "outlook-mail") {
    params.set("prompt", "consent");
  }
  if (args.type === "reddit") {
    params.set("duration", "permanent");
  }
  if (args.type === "dropbox") {
    params.set("token_access_type", "offline");
    params.set("force_reapprove", "true");
  }
  if (args.type === "strava") {
    params.set("approval_prompt", "force");
  }
  if (args.type === "linear") {
    params.set("actor", "user");
    params.set("prompt", "consent");
  }

  const pkceSuffix = deterministicPkceSuffix(args.type);
  if (pkceSuffix) {
    const verifier = await base64UrlSha256(`${args.state}:${pkceSuffix}`);
    params.set("code_challenge", await codeChallenge(verifier));
    params.set("code_challenge_method", "S256");
  }

  if (args.type === "airtable") {
    const verifier = generateCodeVerifier();
    params.set("code_challenge", await codeChallenge(verifier));
    params.set("code_challenge_method", "S256");
    return {
      url: `${oauthConfig.authorizationUrl}?${params.toString()}`,
      codeVerifier: verifier,
    };
  }

  return { url: `${oauthConfig.authorizationUrl}?${params.toString()}` };
}

const getConnectorListInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const result = await get(
    zeroConnectorList({ orgId: auth.orgId, userId: auth.userId }),
  );
  return { status: 200 as const, body: result };
});

const getConnectorByTypeInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroConnectorsByTypeContract.get));
  const connector = await get(
    zeroConnectorByType({
      orgId: auth.orgId,
      userId: auth.userId,
      type: params.type,
    }),
  );
  if (!connector) {
    return notFound("Connector not found");
  }

  return { status: 200 as const, body: connector };
});

const getComputerConnectorInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const connector = await get(
    zeroConnectorByType({
      orgId: auth.orgId,
      userId: auth.userId,
      type: "computer",
      includeHiddenStoredConnector: true,
    }),
  );
  if (!connector) {
    return notFound("Computer connector not found");
  }

  return { status: 200 as const, body: connector };
});

const createComputerConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const result = await set(
      createComputerConnector$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    signal.throwIfAborted();

    switch (result.kind) {
      case "created": {
        return { status: 200 as const, body: result.connector };
      }
      case "bad_request": {
        return badRequestMessage("Invalid request");
      }
      case "conflict": {
        return conflict("Resource conflict");
      }
    }
    const exhaustive: never = result;
    return exhaustive;
  },
);

const deleteComputerConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const deleted = await set(
      deleteComputerConnector$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    signal.throwIfAborted();

    if (!deleted) {
      return notFound("Computer connector not found");
    }

    return { status: 204 as const, body: undefined };
  },
);

const deleteConnectorByTypeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroConnectorsByTypeContract.delete));
    const deleted = await set(
      deleteZeroConnectorLocalState$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        type: params.type,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!deleted) {
      return notFound("Connector not found");
    }

    return { status: 204 as const, body: undefined };
  },
);

const getScopeDiffInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroConnectorScopeDiffContract.getScopeDiff));
  const diff = await get(
    zeroConnectorScopeDiff({
      orgId: auth.orgId,
      userId: auth.userId,
      type: params.type,
    }),
  );
  if (!diff) {
    return notFound("Connector not found");
  }

  return { status: 200 as const, body: diff };
});

const searchConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(zeroConnectorsSearchContract.search));
  const connectors = await get(
    zeroConnectorSearch({
      orgId: auth.orgId,
      userId: auth.userId,
      keyword: query.keyword,
    }),
  );
  return { status: 200 as const, body: { connectors: [...connectors] } };
});

const connectRemoteAgentConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const result = await set(
      connectRemoteAgentConnector$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "no_online_host") {
      return conflict("Start an online remote-agent host before connecting");
    }

    return { status: 200 as const, body: result.connector };
  },
);

const connectLocalBrowserConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    if (
      !isLocalBrowserEnabled({
        orgId: auth.orgId,
        userId: auth.userId,
        overrides,
      })
    ) {
      return localBrowserDisabled;
    }

    const result = await set(
      connectLocalBrowserConnector$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "no_online_host") {
      return conflict("Start an online local-browser host before connecting");
    }

    return { status: 200 as const, body: result.connector };
  },
);

export function createAuthorizeConnectorInner(route: ConnectorAuthorizeRoute) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParamsOf(route));
    const query = get(queryOf(route));
    const request = get(request$).raw;
    const origin = getRequestOrigin(request);
    const requestUrl = new URL(request.url);

    const typeResult = connectorTypeSchema.safeParse(params.type);
    if (!typeResult.success) {
      return jsonResponse(
        { error: `Unknown connector type: ${params.type}` },
        400,
      );
    }
    const type = typeResult.data;

    const auth = await set(
      requiredAuthContext$,
      { requireOrganization: true },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in auth) {
      if (auth.status === 401) {
        const loginUrl = new URL("/sign-in", origin);
        const authorizeUrl = new URL(
          `${requestUrl.pathname}${requestUrl.search}`,
          origin,
        );
        loginUrl.searchParams.set("redirect_url", authorizeUrl.toString());
        return redirectResponse(loginUrl.toString());
      }
      return jsonResponse(auth.body, auth.status);
    }

    if (type === "computer") {
      return jsonResponse(
        { error: "Computer connector does not use OAuth" },
        400,
      );
    }

    if (isRefreshOnlyConnectorType(type)) {
      return jsonResponse(
        {
          error:
            "codex-oauth does not use browser OAuth authorization; use the codex auth.json paste flow",
        },
        400,
      );
    }
    if (!("oauth" in getConnectorAuthMethods(type))) {
      return jsonResponse(
        { error: `${type} connector does not use OAuth` },
        400,
      );
    }

    if (!auth.orgId) {
      return jsonResponse(
        {
          error: {
            message:
              "Explicit org context required — ensure active org in session",
            code: "BAD_REQUEST",
          },
        },
        400,
      );
    }

    const state = generateState();
    const redirectUri = `${origin}/api/connectors/${type}/callback`;
    const envKeys = getConnectorOAuthEnvKeys(type);
    const clientId = envKeys ? optionalEnv(envKeys.clientId) : undefined;
    if (!clientId) {
      return jsonResponse({ error: `${type} OAuth not configured` }, 500);
    }

    const authResult = await buildAuthorizeUrl({
      type,
      clientId,
      redirectUri,
      state,
    });
    signal.throwIfAborted();
    if (!authResult) {
      return jsonResponse({ error: `${type} OAuth not configured` }, 500);
    }

    await set(
      deleteZeroConnectorLocalState$,
      { orgId: auth.orgId, userId: auth.userId, type },
      signal,
    );
    signal.throwIfAborted();

    const response = redirectResponse(authResult.url);
    response.headers.append(
      "Set-Cookie",
      buildCookieHeader(STATE_COOKIE_NAME, state, COOKIE_MAX_AGE),
    );
    if (authResult.codeVerifier) {
      response.headers.append(
        "Set-Cookie",
        buildCookieHeader(
          PKCE_COOKIE_NAME,
          authResult.codeVerifier,
          COOKIE_MAX_AGE,
        ),
      );
    }
    if (query.session) {
      response.headers.append(
        "Set-Cookie",
        buildCookieHeader(SESSION_COOKIE_NAME, query.session, COOKIE_MAX_AGE),
      );
    }
    return response;
  });
}

const authorizeConnectorInner$ = createAuthorizeConnectorInner(
  zeroConnectorAuthorizeContract.authorize,
);

const createConnectorSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(zeroConnectorSessionsContract.create));
    const code = generateConnectorSessionCode();
    const expiresAt = new Date(
      nowDate().getTime() + CONNECTOR_SESSION_TTL_SECONDS * 1000,
    );
    const writeDb = set(writeDb$);

    const [session] = await writeDb
      .insert(connectorSessions)
      .values({
        code,
        type: params.type,
        userId: auth.userId,
        status: "pending",
        expiresAt,
      })
      .returning({ id: connectorSessions.id });
    signal.throwIfAborted();

    if (!session) {
      throw new Error("Failed to create connector session");
    }

    return {
      status: 200 as const,
      body: {
        id: session.id,
        code,
        type: params.type,
        status: "pending" as const,
        verificationUrl: `/api/connectors/${params.type}/authorize?session=${session.id}`,
        expiresIn: CONNECTOR_SESSION_TTL_SECONDS,
        interval: CONNECTOR_SESSION_POLL_INTERVAL_SECONDS,
      },
    };
  },
);

const getConnectorSessionByIdInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(zeroConnectorSessionByIdContract.get));
    const writeDb = set(writeDb$);

    const [session] = await writeDb
      .select()
      .from(connectorSessions)
      .where(
        and(
          eq(connectorSessions.id, params.sessionId),
          eq(connectorSessions.type, params.type),
          eq(connectorSessions.userId, auth.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!session) {
      return notFound("Connector session not found");
    }

    if (session.status === "pending" && nowDate() > session.expiresAt) {
      await writeDb
        .update(connectorSessions)
        .set({ status: "expired" })
        .where(eq(connectorSessions.id, session.id));
      signal.throwIfAborted();

      return {
        status: 200 as const,
        body: {
          status: "expired" as const,
          errorMessage: "Session has expired",
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        status: session.status,
        errorMessage: session.errorMessage,
      },
    };
  },
);

export const zeroConnectorsRoutes: readonly RouteEntry[] = [
  {
    route: zeroComputerConnectorContract.create,
    handler: authRoute(connectorWriteAuth, createComputerConnectorInner$),
  },
  {
    route: zeroComputerConnectorContract.get,
    handler: authRoute(connectorReadAuth, getComputerConnectorInner$),
  },
  {
    route: zeroComputerConnectorContract.delete,
    handler: authRoute(connectorWriteAuth, deleteComputerConnectorInner$),
  },
  {
    route: zeroRemoteAgentConnectorContract.create,
    handler: authRoute(connectorWriteAuth, connectRemoteAgentConnectorInner$),
  },
  {
    route: zeroLocalBrowserConnectorContract.create,
    handler: authRoute(connectorWriteAuth, connectLocalBrowserConnectorInner$),
  },
  {
    route: zeroConnectorsSearchContract.search,
    handler: authRoute(connectorReadAuth, searchConnectorsInner$),
  },
  {
    route: zeroConnectorsMainContract.list,
    handler: authRoute(connectorReadAuth, getConnectorListInner$),
  },
  {
    route: zeroConnectorScopeDiffContract.getScopeDiff,
    handler: authRoute(connectorReadAuth, getScopeDiffInner$),
  },
  {
    route: zeroConnectorAuthorizeContract.authorize,
    handler: authorizeConnectorInner$,
  },
  {
    route: zeroConnectorSessionByIdContract.get,
    handler: authRoute({}, getConnectorSessionByIdInner$),
  },
  {
    route: zeroConnectorSessionsContract.create,
    handler: authRoute({}, createConnectorSessionInner$),
  },
  {
    route: zeroConnectorsByTypeContract.get,
    handler: authRoute(connectorReadAuth, getConnectorByTypeInner$),
  },
  {
    route: zeroConnectorsByTypeContract.delete,
    handler: authRoute(connectorWriteAuth, deleteConnectorByTypeInner$),
  },
];
