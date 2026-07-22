import { command } from "ccstate";
import {
  connectorsTypeCallbackContract,
  type ConnectorOauthCallbackResult,
} from "@vm0/api-contracts/contracts/connectors-type-callback";
import {
  connectorAuthMethodIdSchema,
  type ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import {
  connectorGrantScopes,
  resolveConnectorAuthClient,
} from "@vm0/connectors/connector-utils";
import {
  exchangeConnectorAuthCodeWithMethod,
  verifyConnectorOpenIdAuthCallbackWithMethod,
  type ConnectorAuthProviderGrantResult,
} from "@vm0/connectors/auth-providers";

import { request$ } from "../context/hono";
import { pathParamsOf, queryOf } from "../context/request";
import { db$, writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { optionalEnv } from "../../lib/env";
import {
  claimConnectorOAuthState,
  getConnectorOAuthStateStatus,
  type StoredOAuthState,
} from "../services/connector-oauth-state.service";
import { authorizeConnectedConnector$ } from "../services/connected-connector-authorization.service";
import {
  connectorActionResolverForSnapshot,
  type ConnectorActionResolver,
  type ResolvedConnectorActionMethod,
} from "../services/connector-action-resolver.service";
import {
  getConnectorRuntimeConnector,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeConnector,
  type ConnectorRuntimeSnapshot,
} from "../services/connector-catalog-runtime.service";
import { upsertConnectorTokenConnection$ } from "../services/zero-connector-data.service";
import {
  linkGithubVm0User,
  loadActiveGithubInstallationForOrg,
} from "../services/github-oauth.service";
import { safeJsonParse, tapError } from "../utils";
import type { RouteEntry } from "../route-entry";
import {
  getConnectorOAuthCanonicalRedirectUrlForMethods,
  getConnectorOAuthOrigin,
} from "./connector-oauth-origin";
import {
  clearConnectorOAuthCookies,
  connectorOAuthRedirectResponse,
} from "./connector-oauth-route-state";
import { openIdRealmForOrigin } from "./connector-openid-auth-start";

type CallbackIdentity = {
  readonly userId: string;
  readonly orgId: string;
};

type CompleteOAuthCallbackInput = {
  readonly resolvedMethod: ResolvedConnectorActionMethod;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
  readonly identity: CallbackIdentity;
  readonly agentId: string | null;
  readonly authorizeAgent: boolean;
  readonly origin: string;
  readonly type: string;
};

type CompleteOpenIdCallbackInput = {
  readonly resolvedMethod: ResolvedConnectorActionMethod;
  readonly callbackParams: Readonly<Record<string, string>>;
  readonly expectedReturnTo: string;
  readonly expectedRealm: string;
  readonly identity: CallbackIdentity;
  readonly agentId: string | null;
  readonly authorizeAgent: boolean;
  readonly origin: string;
  readonly type: string;
};

type ResolveCallbackStateInput = {
  readonly origin: string;
  readonly type: string;
  readonly connectorRef: ConnectorRef;
  readonly storedState: StoredOAuthState;
  readonly resolver: ConnectorActionResolver;
};

type ResolveOpenIdCallbackStateInput = {
  readonly origin: string;
  readonly type: string;
  readonly connectorRef: ConnectorRef;
  readonly storedState: StoredOAuthState;
  readonly resolver: ConnectorActionResolver;
};

type ResolvedCallbackState =
  | {
      readonly ok: true;
      readonly identity: CallbackIdentity;
      readonly agentId: string | null;
      readonly authorizeAgent: boolean;
      readonly codeVerifier: string | undefined;
      readonly oauthContext: string | undefined;
      readonly redirectUri: string;
      readonly resolvedMethod: ResolvedConnectorActionMethod;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type ResolvedOpenIdCallbackState =
  | {
      readonly ok: true;
      readonly identity: CallbackIdentity;
      readonly agentId: string | null;
      readonly authorizeAgent: boolean;
      readonly expectedReturnTo: string;
      readonly expectedRealm: string;
      readonly resolvedMethod: ResolvedConnectorActionMethod;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type ClaimedCallbackState =
  | {
      readonly ok: true;
      readonly storedState: StoredOAuthState;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type ConnectorCallbackQuery = Readonly<Record<string, string | undefined>>;

function redirectWithError(
  origin: string,
  type: string,
  message: string,
  clearCookies = false,
): Response {
  const errorUrl = new URL("/connector/error", origin);
  errorUrl.searchParams.set("type", type);
  errorUrl.searchParams.set("message", message);

  const response = connectorOAuthRedirectResponse(errorUrl.toString());
  if (clearCookies) {
    clearConnectorOAuthCookies(response);
  }
  return response;
}

function invalidStateRedirectResponse(origin: string, type: string): Response {
  return redirectWithError(
    origin,
    type,
    "Invalid state - please try again",
    true,
  );
}

function missingAuthorizationCodeRedirectResponse(
  origin: string,
  type: string,
): Response {
  return redirectWithError(origin, type, "Missing authorization code", true);
}

function missingStateRedirectResponse(origin: string, type: string): Response {
  return redirectWithError(origin, type, "Missing state parameter", true);
}

async function exchangeTokenForConnector(args: {
  readonly resolvedMethod: ResolvedConnectorActionMethod;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}): Promise<ConnectorAuthProviderGrantResult> {
  if (
    args.resolvedMethod.method.grant.kind !== "auth-code" ||
    args.resolvedMethod.method.client === undefined
  ) {
    throw new Error("Connector execution is not configured");
  }
  const authClient = resolveConnectorAuthClient(
    args.resolvedMethod.method.client,
    optionalEnv,
  );
  if (!authClient) {
    throw new Error(
      `${args.resolvedMethod.connectorRef} auth client not configured`,
    );
  }

  return await exchangeConnectorAuthCodeWithMethod({
    connectorRef: args.resolvedMethod.connectorRef,
    authMethodId: args.resolvedMethod.authMethodId,
    method: args.resolvedMethod.method,
    authClient,
    code: args.code,
    redirectUri: args.redirectUri,
    state: args.state,
    codeVerifier: args.codeVerifier,
    oauthContext: args.oauthContext,
  });
}

async function verifyOpenIdForConnector(args: {
  readonly resolvedMethod: ResolvedConnectorActionMethod;
  readonly callbackParams: Readonly<Record<string, string>>;
  readonly expectedReturnTo: string;
  readonly expectedRealm: string;
  readonly signal: AbortSignal;
}): Promise<ConnectorAuthProviderGrantResult> {
  return await verifyConnectorOpenIdAuthCallbackWithMethod({
    connectorRef: args.resolvedMethod.connectorRef,
    authMethodId: args.resolvedMethod.authMethodId,
    method: args.resolvedMethod.method,
    callbackParams: args.callbackParams,
    expectedReturnTo: args.expectedReturnTo,
    expectedRealm: args.expectedRealm,
    signal: args.signal,
  });
}

function resolveConnectorWithGrant(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly connectorRef: ConnectorRef;
  readonly grantKind: "auth-code" | "openid-auth";
  readonly origin: string;
  readonly type: string;
}):
  | { readonly ok: true; readonly connector: ConnectorRuntimeConnector }
  | { readonly ok: false; readonly response: Response } {
  const connector = getConnectorRuntimeConnector(
    args.snapshot,
    args.connectorRef,
  );
  if (!connector) {
    return {
      ok: false,
      response: redirectWithError(
        args.origin,
        args.type,
        "Unknown connector type",
      ),
    };
  }
  if (
    ![...connector.methods.values()].some((runtimeMethod) => {
      return runtimeMethod.method.grant.kind === args.grantKind;
    })
  ) {
    const label = args.grantKind === "auth-code" ? "auth-code" : "OpenID auth";
    return {
      ok: false,
      response: redirectWithError(
        args.origin,
        args.type,
        `${args.type} connector does not use an ${label} grant`,
      ),
    };
  }
  return { ok: true, connector };
}

async function claimStoredOAuthStateForCallback(args: {
  readonly db: Db;
  readonly state: string;
  readonly connectorRef: ConnectorRef;
  readonly origin: string;
  readonly type: string;
  readonly signal: AbortSignal;
}): Promise<ClaimedCallbackState> {
  const storedStateResolution = await claimConnectorOAuthState(
    args.db,
    { state: args.state, connectorType: args.connectorRef },
    args.signal,
  );
  if (storedStateResolution.kind === "invalid") {
    return {
      ok: false,
      response: invalidStateRedirectResponse(args.origin, args.type),
    };
  }
  if (storedStateResolution.kind === "missing") {
    return {
      ok: false,
      response: invalidStateRedirectResponse(args.origin, args.type),
    };
  }

  return {
    ok: true,
    storedState: storedStateResolution.state,
  };
}

async function rejectInvalidStoredOAuthStateForCallback(args: {
  readonly db: Db;
  readonly state: string;
  readonly connectorRef: ConnectorRef;
  readonly origin: string;
  readonly type: string;
  readonly signal: AbortSignal;
}): Promise<Response | undefined> {
  const status = await getConnectorOAuthStateStatus(
    args.db,
    { state: args.state, connectorType: args.connectorRef },
    args.signal,
  );
  if (status.kind === "usable") {
    return undefined;
  }

  return invalidStateRedirectResponse(args.origin, args.type);
}

function invalidStoredAuthMethodResponse(
  origin: string,
  type: string,
): Response {
  return redirectWithError(
    origin,
    type,
    "Invalid connector auth method - please try again",
    true,
  );
}

async function resolveStoredCallbackMethod(args: {
  readonly resolver: ConnectorActionResolver;
  readonly connectorRef: ConnectorRef;
  readonly authMethod: string;
  readonly expectedGrantKind: "auth-code" | "openid-auth";
  readonly origin: string;
  readonly type: string;
}): Promise<
  | {
      readonly ok: true;
      readonly resolvedMethod: ResolvedConnectorActionMethod;
    }
  | { readonly ok: false; readonly response: Response }
> {
  const authMethodResult = connectorAuthMethodIdSchema.safeParse(
    args.authMethod,
  );
  if (!authMethodResult.success) {
    return {
      ok: false,
      response: invalidStoredAuthMethodResponse(args.origin, args.type),
    };
  }

  const resolvedMethod = await args.resolver.resolveMethod({
    connectorRef: args.connectorRef,
    authMethodId: authMethodResult.data,
    expectedGrantKind: args.expectedGrantKind,
  });
  if (!resolvedMethod.ok) {
    return {
      ok: false,
      response: invalidStoredAuthMethodResponse(args.origin, args.type),
    };
  }

  return {
    ok: true,
    resolvedMethod,
  };
}

async function linkGithubIntegrationAfterConnectorConnect(args: {
  readonly db: Db;
  readonly connectorRef: ConnectorRef;
  readonly identity: CallbackIdentity;
  readonly token: ConnectorAuthProviderGrantResult;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.connectorRef !== "github") {
    return;
  }

  const installation = await loadActiveGithubInstallationForOrg({
    db: args.db,
    orgId: args.identity.orgId,
    signal: args.signal,
  });
  if (!installation) {
    return;
  }

  const githubUserId = await linkGithubVm0User({
    db: args.db,
    installRecordId: installation.id,
    vm0UserId: args.identity.userId,
    knownGithubUserId: args.token.userInfo.id,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  if (githubUserId) {
    await publishUserSignal([args.identity.userId], "github:changed");
  }
}

function successRedirectResponse(args: {
  readonly origin: string;
  readonly type: string;
  readonly username: string | null | undefined;
}): Response {
  const successUrl = new URL("/connector/success", args.origin);
  successUrl.searchParams.set("type", args.type);
  successUrl.searchParams.set("username", args.username ?? "");

  const response = connectorOAuthRedirectResponse(successUrl.toString());
  clearConnectorOAuthCookies(response);
  return response;
}

function callbackResultFromRedirect(
  response: Response,
): ConnectorOauthCallbackResult {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Connector callback response is missing a redirect");
  }
  const url = new URL(location);
  if (url.pathname === "/connector/success") {
    return {
      status: "success",
      username: url.searchParams.get("username") || null,
    };
  }
  if (url.pathname === "/connector/error") {
    return {
      status: "error",
      message:
        url.searchParams.get("message") ||
        "OAuth authorization failed. Please try again.",
    };
  }
  throw new Error(`Unexpected connector callback redirect: ${location}`);
}

function callbackOAuthContext(args: {
  readonly storedContext: string | undefined;
  readonly realmId: string | undefined;
  readonly domain: string | undefined;
}): string | undefined {
  if (!args.realmId && !args.domain) {
    return args.storedContext;
  }
  return JSON.stringify({
    ...(args.storedContext ? { storedContext: args.storedContext } : {}),
    ...(args.realmId ? { realmId: args.realmId } : {}),
    ...(args.domain ? { domain: args.domain } : {}),
  });
}

const completeOAuthCallback$ = command(
  async (
    { set },
    args: CompleteOAuthCallbackInput,
    signal: AbortSignal,
  ): Promise<Response> => {
    const token = await exchangeTokenForConnector({
      resolvedMethod: args.resolvedMethod,
      code: args.code,
      redirectUri: args.redirectUri,
      state: args.state,
      codeVerifier: args.codeVerifier,
      oauthContext: args.oauthContext,
    });
    signal.throwIfAborted();

    const result = await set(
      upsertConnectorTokenConnection$,
      {
        orgId: args.identity.orgId,
        userId: args.identity.userId,
        runtimeMethod: args.resolvedMethod.runtimeMethod,
        snapshot: args.resolvedMethod.snapshot,
        outputs: token.outputs,
        userInfo: token.userInfo,
        oauthScopes: connectorGrantScopes(args.resolvedMethod.method.grant),
        expiresIn: token.expiresIn,
        extraConnectorSecrets: token.extraConnectorSecrets,
      },
      signal,
    );
    signal.throwIfAborted();

    if (args.authorizeAgent) {
      const authorization = await set(
        authorizeConnectedConnector$,
        {
          orgId: args.identity.orgId,
          userId: args.identity.userId,
          agentId: args.agentId,
          connectorType: args.resolvedMethod.connectorRef,
        },
        signal,
      );
      if (authorization.status === "agentNotFound") {
        return redirectWithError(
          args.origin,
          args.type,
          authorization.message,
          true,
        );
      }
    }

    await linkGithubIntegrationAfterConnectorConnect({
      db: set(writeDb$),
      connectorRef: args.resolvedMethod.connectorRef,
      identity: args.identity,
      token,
      signal,
    });
    signal.throwIfAborted();

    return successRedirectResponse({
      origin: args.origin,
      type: args.type,
      username: result.connector.externalUsername,
    });
  },
);

const completeOpenIdCallback$ = command(
  async (
    { set },
    args: CompleteOpenIdCallbackInput,
    signal: AbortSignal,
  ): Promise<Response> => {
    const token = await verifyOpenIdForConnector({
      resolvedMethod: args.resolvedMethod,
      callbackParams: args.callbackParams,
      expectedReturnTo: args.expectedReturnTo,
      expectedRealm: args.expectedRealm,
      signal,
    });
    signal.throwIfAborted();

    const result = await set(
      upsertConnectorTokenConnection$,
      {
        orgId: args.identity.orgId,
        userId: args.identity.userId,
        runtimeMethod: args.resolvedMethod.runtimeMethod,
        snapshot: args.resolvedMethod.snapshot,
        outputs: token.outputs,
        userInfo: token.userInfo,
        oauthScopes: token.scopes,
        expiresIn: token.expiresIn,
        extraConnectorSecrets: token.extraConnectorSecrets,
      },
      signal,
    );
    signal.throwIfAborted();

    if (args.authorizeAgent) {
      const authorization = await set(
        authorizeConnectedConnector$,
        {
          orgId: args.identity.orgId,
          userId: args.identity.userId,
          agentId: args.agentId,
          connectorType: args.resolvedMethod.connectorRef,
        },
        signal,
      );
      if (authorization.status === "agentNotFound") {
        return redirectWithError(
          args.origin,
          args.type,
          authorization.message,
          true,
        );
      }
    }

    return successRedirectResponse({
      origin: args.origin,
      type: args.type,
      username: result.connector.externalUsername,
    });
  },
);

async function resolveCallbackState(
  args: ResolveCallbackStateInput,
  signal: AbortSignal,
): Promise<ResolvedCallbackState> {
  const authMethodResult = await resolveStoredCallbackMethod({
    resolver: args.resolver,
    connectorRef: args.connectorRef,
    authMethod: args.storedState.authMethod,
    expectedGrantKind: "auth-code",
    origin: args.origin,
    type: args.type,
  });
  signal.throwIfAborted();
  if (!authMethodResult.ok) {
    return authMethodResult;
  }

  return {
    ok: true,
    identity: {
      userId: args.storedState.userId,
      orgId: args.storedState.orgId,
    },
    agentId: args.storedState.agentId,
    authorizeAgent: args.storedState.authorizeAgent,
    resolvedMethod: authMethodResult.resolvedMethod,
    codeVerifier: args.storedState.codeVerifier ?? undefined,
    oauthContext: args.storedState.oauthContext ?? undefined,
    redirectUri: args.storedState.redirectUri,
  };
}

function storedOpenIdRealm(
  storedContext: string | null,
  expectedReturnTo: string,
): string {
  if (storedContext) {
    const parsed = safeJsonParse(storedContext);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "realm" in parsed &&
      typeof parsed.realm === "string"
    ) {
      return parsed.realm;
    }
  }
  return openIdRealmForOrigin(new URL(expectedReturnTo).origin);
}

async function resolveOpenIdCallbackState(
  args: ResolveOpenIdCallbackStateInput,
  signal: AbortSignal,
): Promise<ResolvedOpenIdCallbackState> {
  const authMethodResult = await resolveStoredCallbackMethod({
    resolver: args.resolver,
    connectorRef: args.connectorRef,
    authMethod: args.storedState.authMethod,
    expectedGrantKind: "openid-auth",
    origin: args.origin,
    type: args.type,
  });
  signal.throwIfAborted();
  if (!authMethodResult.ok) {
    return authMethodResult;
  }

  return {
    ok: true,
    identity: {
      userId: args.storedState.userId,
      orgId: args.storedState.orgId,
    },
    agentId: args.storedState.agentId,
    authorizeAgent: args.storedState.authorizeAgent,
    resolvedMethod: authMethodResult.resolvedMethod,
    expectedReturnTo: args.storedState.redirectUri,
    expectedRealm: storedOpenIdRealm(
      args.storedState.oauthContext,
      args.storedState.redirectUri,
    ),
  };
}

function hasOpenIdCallbackFields(query: ConnectorCallbackQuery): boolean {
  return Object.keys(query).some((name) => {
    return name.startsWith("openid.");
  });
}

function openIdCallbackParamsFromQuery(
  query: ConnectorCallbackQuery,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).flatMap(([name, value]) => {
      return value === undefined || !name.startsWith("openid.")
        ? []
        : ([[name, value]] as const);
    }),
  );
}

const handleOpenIdConnectorCallback$ = command(
  async (
    { get, set },
    args: {
      readonly type: ConnectorRef;
      readonly query: ConnectorCallbackQuery;
      readonly origin: string;
      readonly snapshot: ConnectorRuntimeSnapshot;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    const connectorResult = resolveConnectorWithGrant({
      snapshot: args.snapshot,
      connectorRef: args.type,
      grantKind: "openid-auth",
      origin: args.origin,
      type: args.type,
    });
    if (!connectorResult.ok) {
      return connectorResult.response;
    }
    const state = args.query.state;
    if (!state) {
      return missingStateRedirectResponse(args.origin, args.type);
    }

    const claimedState = await claimStoredOAuthStateForCallback({
      db: set(writeDb$),
      connectorRef: args.type,
      origin: args.origin,
      type: args.type,
      signal,
      state,
    });
    signal.throwIfAborted();
    if (!claimedState.ok) {
      return claimedState.response;
    }

    const resolver = await get(
      connectorActionResolverForSnapshot(args.snapshot),
    );
    signal.throwIfAborted();
    const resolvedState = await resolveOpenIdCallbackState(
      {
        origin: args.origin,
        type: args.type,
        connectorRef: args.type,
        storedState: claimedState.storedState,
        resolver,
      },
      signal,
    );
    if (!resolvedState.ok) {
      return resolvedState.response;
    }

    const callbackResponse = await tapError(
      set(
        completeOpenIdCallback$,
        {
          resolvedMethod: resolvedState.resolvedMethod,
          callbackParams: openIdCallbackParamsFromQuery(args.query),
          expectedReturnTo: resolvedState.expectedReturnTo,
          expectedRealm: resolvedState.expectedRealm,
          identity: resolvedState.identity,
          agentId: resolvedState.agentId,
          authorizeAgent: resolvedState.authorizeAgent,
          origin: args.origin,
          type: args.type,
        },
        signal,
      ),
    );
    signal.throwIfAborted();

    if (callbackResponse) {
      return callbackResponse;
    }

    return redirectWithError(
      args.origin,
      args.type,
      "OpenID authorization failed. Please try again.",
      true,
    );
  },
);

function authCodeCallbackPreflight(args: {
  readonly type: ConnectorRef;
  readonly query: ConnectorCallbackQuery;
  readonly request: Request;
  readonly origin: string;
  readonly snapshot: ConnectorRuntimeSnapshot;
}): Response | null {
  const connectorResult = resolveConnectorWithGrant({
    snapshot: args.snapshot,
    connectorRef: args.type,
    grantKind: "auth-code",
    origin: args.origin,
    type: args.type,
  });
  if (!connectorResult.ok) {
    return connectorResult.response;
  }
  if (args.query.responseMode === "json") {
    return null;
  }
  const canonicalRedirectUrl = getConnectorOAuthCanonicalRedirectUrlForMethods(
    args.request,
    [...connectorResult.connector.methods.values()]
      .filter((runtimeMethod) => {
        return runtimeMethod.executable;
      })
      .map((runtimeMethod) => {
        return runtimeMethod.method;
      }),
  );
  return canonicalRedirectUrl
    ? connectorOAuthRedirectResponse(canonicalRedirectUrl)
    : null;
}

const handleAuthCodeConnectorCallback$ = command(
  async (
    { get, set },
    args: {
      readonly type: ConnectorRef;
      readonly query: ConnectorCallbackQuery;
      readonly request: Request;
      readonly origin: string;
      readonly snapshot: ConnectorRuntimeSnapshot;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    const preflightResponse = authCodeCallbackPreflight(args);
    if (preflightResponse) {
      return preflightResponse;
    }

    const state = args.query.state;
    const storedStateCallbackArgs = {
      db: set(writeDb$),
      connectorRef: args.type,
      origin: args.origin,
      type: args.type,
      signal,
    };

    if (args.query.error) {
      if (state) {
        const claimedState = await claimStoredOAuthStateForCallback({
          ...storedStateCallbackArgs,
          state,
        });
        signal.throwIfAborted();
        if (!claimedState.ok) {
          return claimedState.response;
        }
      }
      return redirectWithError(
        args.origin,
        args.type,
        args.query.error_description ||
          args.query.error ||
          "OAuth authorization failed",
        true,
      );
    }

    const code = args.query.code ?? args.query.auth_code;
    if (!code) {
      if (state) {
        const invalidStateResponse =
          await rejectInvalidStoredOAuthStateForCallback({
            ...storedStateCallbackArgs,
            state,
          });
        signal.throwIfAborted();
        if (invalidStateResponse) {
          return invalidStateResponse;
        }
      }
      return missingAuthorizationCodeRedirectResponse(args.origin, args.type);
    }

    if (!state) {
      return missingStateRedirectResponse(args.origin, args.type);
    }

    const claimedState = await claimStoredOAuthStateForCallback({
      ...storedStateCallbackArgs,
      state,
    });
    signal.throwIfAborted();
    if (!claimedState.ok) {
      return claimedState.response;
    }

    const resolver = await get(
      connectorActionResolverForSnapshot(args.snapshot),
    );
    signal.throwIfAborted();
    const resolvedState = await resolveCallbackState(
      {
        origin: args.origin,
        type: args.type,
        connectorRef: args.type,
        storedState: claimedState.storedState,
        resolver,
      },
      signal,
    );
    if (!resolvedState.ok) {
      return resolvedState.response;
    }

    const callbackResponse = await tapError(
      set(
        completeOAuthCallback$,
        {
          resolvedMethod: resolvedState.resolvedMethod,
          code,
          redirectUri: resolvedState.redirectUri,
          state,
          codeVerifier: resolvedState.codeVerifier,
          oauthContext: callbackOAuthContext({
            storedContext: resolvedState.oauthContext,
            realmId: args.query.realmId,
            domain: args.query.domain,
          }),
          identity: resolvedState.identity,
          agentId: resolvedState.agentId,
          authorizeAgent: resolvedState.authorizeAgent,
          origin: args.origin,
          type: args.type,
        },
        signal,
      ),
    );
    signal.throwIfAborted();

    if (callbackResponse) {
      return callbackResponse;
    }

    return redirectWithError(
      args.origin,
      args.type,
      "OAuth authorization failed. Please try again.",
      true,
    );
  },
);

const callbackConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const { type } = get(pathParamsOf(connectorsTypeCallbackContract.callback));
    const query = get(queryOf(connectorsTypeCallbackContract.callback));
    const request = get(request$).raw;
    const origin = getConnectorOAuthOrigin(request);
    const snapshot = await loadConnectorRuntimeSnapshot(get(db$));
    signal.throwIfAborted();

    const response = hasOpenIdCallbackFields(query)
      ? await set(
          handleOpenIdConnectorCallback$,
          {
            type,
            query,
            origin,
            snapshot,
          },
          signal,
        )
      : await set(
          handleAuthCodeConnectorCallback$,
          {
            type,
            query,
            request,
            origin,
            snapshot,
          },
          signal,
        );
    signal.throwIfAborted();

    return query.responseMode === "json"
      ? { status: 200 as const, body: callbackResultFromRedirect(response) }
      : response;
  },
);

export const connectorsTypeCallbackRoutes: readonly RouteEntry[] = [
  {
    route: connectorsTypeCallbackContract.callback,
    handler: callbackConnectorInner$,
  },
];
