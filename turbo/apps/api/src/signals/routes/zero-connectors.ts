import { randomInt } from "node:crypto";

import { command, computed } from "ccstate";
import type { AppRoute } from "@ts-rest/core";
import {
  zeroConnectorAuthorizeContract,
  zeroConnectorManualGrantContract,
  zeroConnectorOauthStartContract,
  zeroConnectorSessionsContract,
  zeroConnectorSessionByIdContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
  zeroConnectorsSearchContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  connectorAuthMethodIdSchema,
  connectorTypeSchema,
  type ConnectorAuthMethodId,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  getConnectorAuthMethod,
  hasConnectorAuthCodeGrant,
} from "@vm0/connectors/connector-utils";
import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";
import { connectorSessions } from "@vm0/db/schema/connector-session";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  authContext$,
  organizationAuthContext$,
  requiredAuthContext$,
} from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { badRequestMessage, notFound } from "../../lib/error";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  connectManualGrantConnector$,
  deleteZeroConnectorLocalState$,
  zeroConnectorByType,
  zeroConnectorList,
  zeroConnectorScopeDiff,
  zeroConnectorSearch,
} from "../services/zero-connector-data.service";
import { userConnectorAvailability } from "../services/connector-availability.service";
import type { RouteEntry } from "../route";
import {
  getConnectorOAuthCanonicalRedirectUrl,
  getConnectorOAuthOrigin,
} from "./connector-oauth-origin";
import {
  buildConnectorOAuthCookieHeader,
  CONNECTOR_OAUTH_CONTEXT_COOKIE_NAME,
  CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS,
  CONNECTOR_OAUTH_PKCE_COOKIE_NAME,
  CONNECTOR_OAUTH_SESSION_COOKIE_NAME,
  CONNECTOR_OAUTH_STATE_COOKIE_NAME,
  connectorOAuthRedirectResponse,
} from "./connector-oauth-route-state";
import {
  buildResolvedConnectorAuthCodeAuthUrl,
  prepareResolvedConnectorAuthCodeStart,
  resolveConnectorAuthCodeStartMethod,
} from "./connector-auth-code-start";

const CONNECTOR_SESSION_TTL_SECONDS = 15 * 60;
const CONNECTOR_SESSION_POLL_INTERVAL_SECONDS = 5;
const CONNECTOR_SESSION_CODE_LENGTH = 8;
const CONNECTOR_SESSION_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

type ConnectorAuthorizeRoute = AppRoute & {
  readonly pathParams: z.ZodType<{ readonly type: string }>;
  readonly query: z.ZodType<{ readonly session?: string }>;
};

const connectorSessionIdSchema = z.uuid();

type ResolvedAuthCodeStartMethod =
  | ReturnType<typeof resolveConnectorAuthCodeStartMethod>
  | { readonly ok: false; readonly reason: "missing_auth_code_grant" };

const connectorReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:read",
} as const;

const connectorWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

function connectorUnavailable(type: string) {
  return {
    status: 403 as const,
    body: {
      error: {
        message: `${type} connector is not available`,
        code: "FORBIDDEN",
      },
    },
  };
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

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function appendConnectorOAuthCookie(
  response: Response,
  name: string,
  value: string | undefined,
): void {
  if (!value) {
    return;
  }
  response.headers.append(
    "Set-Cookie",
    buildConnectorOAuthCookieHeader(
      name,
      value,
      CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS,
    ),
  );
}

function connectorOAuthStartRedirectResponse(args: {
  readonly url: string;
  readonly state: string;
  readonly codeVerifier?: string;
  readonly oauthContext?: string;
  readonly session?: string;
}): Response {
  const response = connectorOAuthRedirectResponse(args.url);
  appendConnectorOAuthCookie(
    response,
    CONNECTOR_OAUTH_STATE_COOKIE_NAME,
    args.state,
  );
  appendConnectorOAuthCookie(
    response,
    CONNECTOR_OAUTH_PKCE_COOKIE_NAME,
    args.codeVerifier,
  );
  appendConnectorOAuthCookie(
    response,
    CONNECTOR_OAUTH_CONTEXT_COOKIE_NAME,
    args.oauthContext,
  );
  appendConnectorOAuthCookie(
    response,
    CONNECTOR_OAUTH_SESSION_COOKIE_NAME,
    args.session,
  );
  return response;
}

function connectorMissingAuthCodeGrantResponse(type: string) {
  return jsonResponse(
    {
      error: `${type} connector does not use an auth-code grant`,
    },
    400,
  );
}

function connectorAuthCodeStartErrorMessage(
  type: string,
  authMethod: string,
  reason:
    | "missing_auth_code_grant"
    | "missing_auth_method"
    | "wrong_grant_kind",
): string {
  switch (reason) {
    case "missing_auth_code_grant": {
      return `${type} connector does not use an auth-code grant`;
    }
    case "missing_auth_method": {
      return `${type} connector does not have ${authMethod} auth method`;
    }
    case "wrong_grant_kind": {
      return `${type} ${authMethod} auth method does not use an auth-code grant`;
    }
  }
}

function connectorAuthorizeAuthCodeStartErrorResponse(
  type: string,
  reason:
    | "invalid_session"
    | "missing_auth_code_grant"
    | "missing_auth_method"
    | "wrong_grant_kind",
) {
  if (reason === "invalid_session") {
    return jsonResponse({ error: "Invalid connector session" }, 400);
  }
  if (reason === "missing_auth_method" || reason === "wrong_grant_kind") {
    return jsonResponse(
      { error: "Invalid connector session auth method" },
      500,
    );
  }
  return connectorMissingAuthCodeGrantResponse(type);
}

function connectorAuthorizeMissingOrgResponse() {
  return jsonResponse(
    {
      error: {
        message: "Explicit org context required — ensure active org in session",
        code: "BAD_REQUEST",
      },
    },
    400,
  );
}

function resolveRequestedAuthCodeStartMethod(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): ResolvedAuthCodeStartMethod {
  if (!hasConnectorAuthCodeGrant(type)) {
    return { ok: false, reason: "missing_auth_code_grant" };
  }
  return resolveConnectorAuthCodeStartMethod(type, authMethod);
}

async function resolveSessionAuthCodeStartMethod(args: {
  readonly writeDb: Db;
  readonly sessionId: string;
  readonly type: ConnectorType;
  readonly userId: string;
}): Promise<
  | ResolvedAuthCodeStartMethod
  | { readonly ok: false; readonly reason: "invalid_session" }
> {
  const [session] = await args.writeDb
    .select({
      type: connectorSessions.type,
      authMethod: connectorSessions.authMethod,
      userId: connectorSessions.userId,
      status: connectorSessions.status,
      expiresAt: connectorSessions.expiresAt,
    })
    .from(connectorSessions)
    .where(eq(connectorSessions.id, args.sessionId))
    .limit(1);

  if (
    !session ||
    session.type !== args.type ||
    session.userId !== args.userId ||
    session.status !== "pending" ||
    session.expiresAt <= nowDate()
  ) {
    return { ok: false, reason: "invalid_session" };
  }

  const authMethodResult = connectorAuthMethodIdSchema.safeParse(
    session.authMethod,
  );
  if (!authMethodResult.success) {
    return { ok: false, reason: "missing_auth_method" };
  }

  return resolveRequestedAuthCodeStartMethod(args.type, authMethodResult.data);
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

const connectManualGrantConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroConnectorManualGrantContract.connect));
    const bodyResult = await get(
      bodyResultOf(zeroConnectorManualGrantContract.connect),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const method = getConnectorAuthMethod(
      params.type,
      bodyResult.data.authMethod,
    );
    if (!method) {
      return badRequestMessage(
        `${params.type} connector does not have ${bodyResult.data.authMethod} auth method`,
      );
    }
    if (method.grant.kind !== "manual") {
      return badRequestMessage(
        `${params.type} ${bodyResult.data.authMethod} auth method does not use a manual grant`,
      );
    }

    const availability = await get(
      userConnectorAvailability(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    if (
      !availability.isAuthMethodAvailable(
        params.type,
        bodyResult.data.authMethod,
      )
    ) {
      return connectorUnavailable(params.type);
    }

    const result = await set(
      connectManualGrantConnector$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        type: params.type,
        authMethod: bodyResult.data.authMethod,
        values: bodyResult.data.values,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "invalid") {
      return badRequestMessage(result.message);
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
      return connectorOAuthRedirectResponse(canonicalRedirectUrl);
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

    const sessionResult = query.session
      ? connectorSessionIdSchema.safeParse(query.session)
      : undefined;
    if (!sessionResult?.success) {
      return jsonResponse({ error: "Invalid connector session" }, 400);
    }
    const sessionId = sessionResult.data;

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
        return connectorOAuthRedirectResponse(loginUrl.toString());
      }
      return jsonResponse(auth.body, auth.status);
    }

    if (!auth.orgId) {
      return connectorAuthorizeMissingOrgResponse();
    }

    const availability = await get(
      userConnectorAvailability(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    const writeDb = set(writeDb$);
    const authCodeStartType = await resolveSessionAuthCodeStartMethod({
      writeDb,
      sessionId,
      type,
      userId: auth.userId,
    });
    signal.throwIfAborted();
    if (!authCodeStartType.ok) {
      return connectorAuthorizeAuthCodeStartErrorResponse(
        type,
        authCodeStartType.reason,
      );
    }
    if (
      !availability.isAuthMethodAvailable(
        authCodeStartType.type,
        authCodeStartType.authMethod,
      )
    ) {
      return jsonResponse({ error: `${type} connector is not available` }, 403);
    }

    const prepared = prepareResolvedConnectorAuthCodeStart({
      type: authCodeStartType.type,
      authMethod: authCodeStartType.authMethod,
      origin,
      readEnv: optionalEnv,
    });
    if (!prepared.ok) {
      return jsonResponse({ error: `${type} OAuth not configured` }, 500);
    }
    const authResult = await buildResolvedConnectorAuthCodeAuthUrl({
      type: authCodeStartType.type,
      authClient: prepared.authClient,
      redirectUri: prepared.redirectUri,
      state: prepared.state,
    });
    signal.throwIfAborted();

    await set(
      deleteZeroConnectorLocalState$,
      { orgId: auth.orgId, userId: auth.userId, type },
      signal,
    );
    signal.throwIfAborted();

    await writeDb.insert(connectorOauthStates).values({
      state: prepared.state,
      type: authCodeStartType.type,
      authMethod: authCodeStartType.authMethod,
      userId: auth.userId,
      orgId: auth.orgId,
      redirectUri: prepared.redirectUri,
      sessionId,
      codeVerifier: authResult.codeVerifier,
      oauthContext: authResult.oauthContext,
      expiresAt: new Date(
        nowDate().getTime() + CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS * 1000,
      ),
    });
    signal.throwIfAborted();

    return connectorOAuthStartRedirectResponse({
      url: authResult.url,
      state: prepared.state,
      codeVerifier: authResult.codeVerifier,
      oauthContext: authResult.oauthContext,
      session: sessionId,
    });
  });
}

const authorizeConnectorInner$ = createAuthorizeConnectorInner(
  zeroConnectorAuthorizeContract.authorize,
);

const startConnectorOauthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParamsOf(zeroConnectorOauthStartContract.start));
    const bodyResult = await get(
      bodyResultOf(zeroConnectorOauthStartContract.start),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const request = get(request$).raw;
    const auth = get(authContext$);
    const type = params.type;

    const authCodeStartType = resolveRequestedAuthCodeStartMethod(
      type,
      bodyResult.data.authMethod,
    );
    if (!authCodeStartType.ok) {
      return badRequestMessage(
        connectorAuthCodeStartErrorMessage(
          type,
          bodyResult.data.authMethod,
          authCodeStartType.reason,
        ),
      );
    }

    if (!auth.orgId) {
      return badRequestMessage(
        "Explicit org context required — ensure active org in session",
      );
    }

    const availability = await get(
      userConnectorAvailability(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    if (
      !availability.isAuthMethodAvailable(
        authCodeStartType.type,
        authCodeStartType.authMethod,
      )
    ) {
      return connectorUnavailable(type);
    }

    const origin = getConnectorOAuthOrigin(request);
    const prepared = prepareResolvedConnectorAuthCodeStart({
      type: authCodeStartType.type,
      authMethod: authCodeStartType.authMethod,
      origin,
      readEnv: optionalEnv,
    });
    if (!prepared.ok) {
      return internalServerError(`${type} OAuth not configured`);
    }
    const authResult = await buildResolvedConnectorAuthCodeAuthUrl({
      type: authCodeStartType.type,
      authClient: prepared.authClient,
      redirectUri: prepared.redirectUri,
      state: prepared.state,
    });
    signal.throwIfAborted();

    await set(
      deleteZeroConnectorLocalState$,
      { orgId: auth.orgId, userId: auth.userId, type },
      signal,
    );
    signal.throwIfAborted();

    const writeDb = set(writeDb$);
    await writeDb.insert(connectorOauthStates).values({
      state: prepared.state,
      type: authCodeStartType.type,
      authMethod: authCodeStartType.authMethod,
      userId: auth.userId,
      orgId: auth.orgId,
      redirectUri: prepared.redirectUri,
      codeVerifier: authResult.codeVerifier,
      oauthContext: authResult.oauthContext,
      expiresAt: new Date(
        nowDate().getTime() + CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS * 1000,
      ),
    });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        authorizationUrl: authResult.url,
      },
    };
  },
);

const createConnectorSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroConnectorSessionsContract.create));
    const bodyResult = await get(
      bodyResultOf(zeroConnectorSessionsContract.create),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const authCodeStartType = resolveRequestedAuthCodeStartMethod(
      params.type,
      bodyResult.data.authMethod,
    );
    if (!authCodeStartType.ok) {
      return badRequestMessage(
        connectorAuthCodeStartErrorMessage(
          params.type,
          bodyResult.data.authMethod,
          authCodeStartType.reason,
        ),
      );
    }

    const availability = await get(
      userConnectorAvailability(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    if (
      !availability.isAuthMethodAvailable(
        authCodeStartType.type,
        authCodeStartType.authMethod,
      )
    ) {
      return connectorUnavailable(params.type);
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
        type: authCodeStartType.type,
        authMethod: authCodeStartType.authMethod,
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
        type: authCodeStartType.type,
        status: "pending" as const,
        verificationUrl: `/api/connectors/${authCodeStartType.type}/authorize?session=${session.id}`,
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
    route: zeroConnectorManualGrantContract.connect,
    handler: authRoute(connectorWriteAuth, connectManualGrantConnectorInner$),
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
    handler: authRoute(connectorWriteAuth, createConnectorSessionInner$),
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
