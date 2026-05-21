import { randomInt } from "node:crypto";

import { command, computed } from "ccstate";
import type { AppRoute } from "@ts-rest/core";
import {
  zeroComputerConnectorContract,
  zeroConnectorAuthorizeContract,
  zeroConnectorOauthStartContract,
  zeroConnectorSessionsContract,
  zeroConnectorSessionByIdContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
  zeroConnectorsSearchContract,
  zeroLocalBrowserConnectorContract,
  zeroLocalAgentConnectorContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  getConnectorAuthMethod,
  getConnectorOAuthCredentials,
  isStaticConnectorOAuthCredentials,
  type ConnectorOAuthCredentials,
} from "@vm0/connectors/connector-utils";
import {
  connectorTypeSchema,
  type ConnectorType,
  type OAuthConnectorType,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isOAuthConnectorType } from "@vm0/connectors/oauth-providers";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";
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
import { optionalEnv } from "../../lib/env";
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
import { connectLocalAgentConnector$ } from "../services/zero-local-agent.service";
import { createComputerConnector$ } from "../services/zero-computer-connector.service";
import type { RouteEntry } from "../route";
import {
  getConnectorOAuthCanonicalRedirectUrl,
  getConnectorOAuthOrigin,
} from "./connector-oauth-origin";
import {
  buildOAuthCookieHeader,
  buildProviderAuthorizeUrl,
  CONNECTOR_OAUTH_CONTEXT_COOKIE_NAME,
  CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS,
  CONNECTOR_OAUTH_PKCE_COOKIE_NAME,
  CONNECTOR_OAUTH_SESSION_COOKIE_NAME,
  CONNECTOR_OAUTH_STATE_COOKIE_NAME,
  generateConnectorOAuthState,
  redirectResponse,
} from "./connector-oauth-route-state";

const CONNECTOR_SESSION_TTL_SECONDS = 15 * 60;
const CONNECTOR_SESSION_POLL_INTERVAL_SECONDS = 5;
const CONNECTOR_SESSION_CODE_LENGTH = 8;
const CONNECTOR_SESSION_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

type ConnectorAuthorizeRoute = AppRoute & {
  readonly pathParams: z.ZodType<{ readonly type: string }>;
  readonly query: z.ZodType<{ readonly session?: string }>;
};

type OAuthConnectorResolution =
  | { readonly ok: true; readonly type: OAuthConnectorType }
  | {
      readonly ok: false;
      readonly reason: "computer" | "not_oauth" | "missing_provider";
    };

type PreparedConnectorOAuthStart =
  | {
      readonly ok: true;
      readonly type: OAuthConnectorType;
      readonly state: string;
      readonly redirectUri: string;
      readonly authorizationUrl: string;
      readonly codeVerifier: string | undefined;
      readonly oauthContext: string | undefined;
    }
  | { readonly ok: false; readonly reason: "not_configured" };

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

function resolveOAuthConnectorType(
  type: ConnectorType,
): OAuthConnectorResolution {
  if (type === "computer") {
    return { ok: false, reason: "computer" };
  }
  if (!getConnectorAuthMethod(type, "oauth")) {
    return { ok: false, reason: "not_oauth" };
  }
  if (!isOAuthConnectorType(type)) {
    return { ok: false, reason: "missing_provider" };
  }
  return { ok: true, type };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function connectorDoesNotUseOAuthResponse(type: string) {
  return jsonResponse({ error: `${type} connector does not use OAuth` }, 400);
}

function missingOAuthProviderResponse(type: string) {
  return jsonResponse({ error: `${type} OAuth provider not configured` }, 500);
}

function getAuthorizeClientId(
  credentials: ConnectorOAuthCredentials,
): string | undefined {
  if (!credentials.configured) {
    return undefined;
  }
  return isStaticConnectorOAuthCredentials(credentials)
    ? credentials.clientId
    : undefined;
}

function internalServerError(message: string) {
  return {
    status: 500 as const,
    body: {
      error: {
        message,
        code: "INTERNAL_SERVER_ERROR",
      },
    },
  };
}

async function prepareConnectorOAuthStart(args: {
  readonly request: Request;
  readonly type: OAuthConnectorType;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
  readonly deleteLocalState: (args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: OAuthConnectorType;
  }) => Promise<void>;
}): Promise<PreparedConnectorOAuthStart> {
  const state = generateConnectorOAuthState();
  const origin = getConnectorOAuthOrigin(args.request);
  const redirectUri = `${origin}/api/connectors/${args.type}/callback`;
  const credentials = getConnectorOAuthCredentials(args.type, optionalEnv);
  if (!credentials?.configured) {
    return { ok: false, reason: "not_configured" };
  }

  const authResult = await buildProviderAuthorizeUrl({
    type: args.type,
    clientId: getAuthorizeClientId(credentials),
    redirectUri,
    state,
  });
  args.signal.throwIfAborted();

  await args.deleteLocalState({
    orgId: args.orgId,
    userId: args.userId,
    type: args.type,
  });
  args.signal.throwIfAborted();

  return {
    ok: true,
    type: args.type,
    state,
    redirectUri,
    authorizationUrl: authResult.url,
    codeVerifier: authResult.codeVerifier,
    oauthContext: authResult.oauthContext,
  };
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

const connectLocalAgentConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const result = await set(
      connectLocalAgentConnector$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "no_online_host") {
      return conflict("Start an online local-agent host before connecting");
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
    const canonicalRedirectUrl = getConnectorOAuthCanonicalRedirectUrl(request);
    if (canonicalRedirectUrl) {
      return redirectResponse(canonicalRedirectUrl);
    }
    const origin = getConnectorOAuthOrigin(request);
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

    const oauthType = resolveOAuthConnectorType(type);
    if (!oauthType.ok) {
      if (oauthType.reason === "computer") {
        return jsonResponse(
          { error: "Computer connector does not use OAuth" },
          400,
        );
      }
      if (oauthType.reason === "not_oauth") {
        return connectorDoesNotUseOAuthResponse(type);
      }
      return missingOAuthProviderResponse(type);
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

    const prepared = await prepareConnectorOAuthStart({
      request,
      type: oauthType.type,
      orgId: auth.orgId,
      userId: auth.userId,
      signal,
      deleteLocalState: async (args) => {
        await set(deleteZeroConnectorLocalState$, args, signal);
      },
    });
    signal.throwIfAborted();
    if (!prepared.ok) {
      return jsonResponse({ error: `${type} OAuth not configured` }, 500);
    }

    const response = redirectResponse(prepared.authorizationUrl);
    response.headers.append(
      "Set-Cookie",
      buildOAuthCookieHeader(
        CONNECTOR_OAUTH_STATE_COOKIE_NAME,
        prepared.state,
        CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS,
      ),
    );
    if (prepared.codeVerifier) {
      response.headers.append(
        "Set-Cookie",
        buildOAuthCookieHeader(
          CONNECTOR_OAUTH_PKCE_COOKIE_NAME,
          prepared.codeVerifier,
          CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS,
        ),
      );
    }
    if (prepared.oauthContext) {
      response.headers.append(
        "Set-Cookie",
        buildOAuthCookieHeader(
          CONNECTOR_OAUTH_CONTEXT_COOKIE_NAME,
          prepared.oauthContext,
          CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS,
        ),
      );
    }
    if (query.session) {
      response.headers.append(
        "Set-Cookie",
        buildOAuthCookieHeader(
          CONNECTOR_OAUTH_SESSION_COOKIE_NAME,
          query.session,
          CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS,
        ),
      );
    }
    return response;
  });
}

const authorizeConnectorInner$ = createAuthorizeConnectorInner(
  zeroConnectorAuthorizeContract.authorize,
);

const startConnectorOauthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParamsOf(zeroConnectorOauthStartContract.start));
    const request = get(request$).raw;
    const auth = get(authContext$);
    const type = params.type;

    const oauthType = resolveOAuthConnectorType(type);
    if (!oauthType.ok) {
      if (oauthType.reason === "computer") {
        return badRequestMessage("Computer connector does not use OAuth");
      }
      if (oauthType.reason === "not_oauth") {
        return badRequestMessage(`${type} connector does not use OAuth`);
      }
      return internalServerError(`${type} OAuth provider not configured`);
    }

    if (!auth.orgId) {
      return badRequestMessage(
        "Explicit org context required — ensure active org in session",
      );
    }

    const prepared = await prepareConnectorOAuthStart({
      request,
      type: oauthType.type,
      orgId: auth.orgId,
      userId: auth.userId,
      signal,
      deleteLocalState: async (args) => {
        await set(deleteZeroConnectorLocalState$, args, signal);
      },
    });
    signal.throwIfAborted();
    if (!prepared.ok) {
      return internalServerError(`${type} OAuth not configured`);
    }

    const writeDb = set(writeDb$);
    await writeDb.insert(connectorOauthStates).values({
      state: prepared.state,
      type: prepared.type,
      userId: auth.userId,
      orgId: auth.orgId,
      redirectUri: prepared.redirectUri,
      codeVerifier: prepared.codeVerifier,
      oauthContext: prepared.oauthContext,
      expiresAt: new Date(
        nowDate().getTime() + CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS * 1000,
      ),
    });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        authorizationUrl: prepared.authorizationUrl,
      },
    };
  },
);

const createConnectorSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(zeroConnectorSessionsContract.create));
    const oauthType = resolveOAuthConnectorType(params.type);
    if (!oauthType.ok) {
      if (oauthType.reason === "computer") {
        return badRequestMessage("Computer connector does not use OAuth");
      }
      if (oauthType.reason === "not_oauth") {
        return badRequestMessage(`${params.type} connector does not use OAuth`);
      }
      return internalServerError(
        `${params.type} OAuth provider not configured`,
      );
    }

    const credentials = getConnectorOAuthCredentials(
      oauthType.type,
      optionalEnv,
    );
    if (!credentials?.configured) {
      return internalServerError(`${params.type} OAuth not configured`);
    }

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
        .where(
          and(
            eq(connectorSessions.id, session.id),
            eq(connectorSessions.type, params.type),
            eq(connectorSessions.userId, auth.userId),
            eq(connectorSessions.status, "pending"),
          ),
        );
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
    route: zeroLocalAgentConnectorContract.create,
    handler: authRoute(connectorWriteAuth, connectLocalAgentConnectorInner$),
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
    route: zeroConnectorOauthStartContract.start,
    handler: authRoute(connectorWriteAuth, startConnectorOauthInner$),
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
