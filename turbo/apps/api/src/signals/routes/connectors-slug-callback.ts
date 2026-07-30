import { command } from "ccstate";
import {
  connectorsSlugCallbackContract,
  type ConnectorOauthCallbackResult,
} from "@vm0/api-contracts/contracts/connectors-slug-callback";
import {
  connectorAuthMethodIdSchema,
  type ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import {
  connectorGrantScopes,
  resolveConnectorAuthClient,
} from "@vm0/connectors/connector-auth-method";
import {
  exchangeConnectorAuthCodeWithMethod,
  verifyConnectorOpenIdAuthCallbackWithMethod,
  type ConnectorAuthProviderGrantResult,
} from "@vm0/connectors/auth-providers";

import { request$, setResHeader$ } from "../context/hono";
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
  readonly connectorSlug: ConnectorSlug;
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
  readonly connectorSlug: ConnectorSlug;
};

type ResolveCallbackStateInput = {
  readonly origin: string;
  readonly connectorSlug: ConnectorSlug;
  readonly storedState: StoredOAuthState;
  readonly resolver: ConnectorActionResolver;
};

type ResolveOpenIdCallbackStateInput = {
  readonly origin: string;
  readonly connectorSlug: ConnectorSlug;
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
  connectorSlug: string,
  message: string,
  clearCookies = false,
): Response {
  const errorUrl = new URL("/connector/error", origin);
  errorUrl.searchParams.set("connectorSlug", connectorSlug);
  errorUrl.searchParams.set("message", message);

  const response = connectorOAuthRedirectResponse(errorUrl.toString());
  if (clearCookies) {
    clearConnectorOAuthCookies(response);
  }
  return response;
}

function invalidStateRedirectResponse(
  origin: string,
  connectorSlug: string,
): Response {
  return redirectWithError(
    origin,
    connectorSlug,
    "Invalid state - please try again",
    true,
  );
}

function missingAuthorizationCodeRedirectResponse(
  origin: string,
  connectorSlug: string,
): Response {
  return redirectWithError(
    origin,
    connectorSlug,
    "Missing authorization code",
    true,
  );
}

function missingStateRedirectResponse(
  origin: string,
  connectorSlug: string,
): Response {
  return redirectWithError(
    origin,
    connectorSlug,
    "Missing state parameter",
    true,
  );
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
      `${args.resolvedMethod.connectorSlug} auth client not configured`,
    );
  }

  return await exchangeConnectorAuthCodeWithMethod({
    connectorSlug: args.resolvedMethod.connectorSlug,
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
    connectorSlug: args.resolvedMethod.connectorSlug,
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
  readonly connectorSlug: ConnectorSlug;
  readonly grantKind: "auth-code" | "openid-auth";
  readonly origin: string;
}):
  | { readonly ok: true; readonly connector: ConnectorRuntimeConnector }
  | { readonly ok: false; readonly response: Response } {
  const connector = getConnectorRuntimeConnector(
    args.snapshot,
    args.connectorSlug,
  );
  if (!connector) {
    return {
      ok: false,
      response: redirectWithError(
        args.origin,
        args.connectorSlug,
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
        args.connectorSlug,
        `${args.connectorSlug} connector does not use an ${label} grant`,
      ),
    };
  }
  return { ok: true, connector };
}

async function claimStoredOAuthStateForCallback(args: {
  readonly db: Db;
  readonly state: string;
  readonly connectorSlug: ConnectorSlug;
  readonly origin: string;
  readonly signal: AbortSignal;
}): Promise<ClaimedCallbackState> {
  const storedStateResolution = await claimConnectorOAuthState(
    args.db,
    { state: args.state, connectorSlug: args.connectorSlug },
    args.signal,
  );
  if (storedStateResolution.kind === "invalid") {
    return {
      ok: false,
      response: invalidStateRedirectResponse(args.origin, args.connectorSlug),
    };
  }
  if (storedStateResolution.kind === "missing") {
    return {
      ok: false,
      response: invalidStateRedirectResponse(args.origin, args.connectorSlug),
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
  readonly connectorSlug: ConnectorSlug;
  readonly origin: string;
  readonly signal: AbortSignal;
}): Promise<Response | undefined> {
  const status = await getConnectorOAuthStateStatus(
    args.db,
    { state: args.state, connectorSlug: args.connectorSlug },
    args.signal,
  );
  if (status.kind === "usable") {
    return undefined;
  }

  return invalidStateRedirectResponse(args.origin, args.connectorSlug);
}

function invalidStoredAuthMethodResponse(
  origin: string,
  connectorSlug: string,
): Response {
  return redirectWithError(
    origin,
    connectorSlug,
    "Invalid connector auth method - please try again",
    true,
  );
}

async function resolveStoredCallbackMethod(args: {
  readonly resolver: ConnectorActionResolver;
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: string;
  readonly expectedGrantKind: "auth-code" | "openid-auth";
  readonly origin: string;
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
      response: invalidStoredAuthMethodResponse(
        args.origin,
        args.connectorSlug,
      ),
    };
  }

  const resolvedMethod = await args.resolver.resolveMethod({
    connectorSlug: args.connectorSlug,
    authMethodId: authMethodResult.data,
    expectedGrantKind: args.expectedGrantKind,
  });
  if (!resolvedMethod.ok) {
    return {
      ok: false,
      response: invalidStoredAuthMethodResponse(
        args.origin,
        args.connectorSlug,
      ),
    };
  }

  return {
    ok: true,
    resolvedMethod,
  };
}

async function linkGithubIntegrationAfterConnectorConnect(args: {
  readonly db: Db;
  readonly connectorSlug: ConnectorSlug;
  readonly identity: CallbackIdentity;
  readonly token: ConnectorAuthProviderGrantResult;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.connectorSlug !== "github") {
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
  readonly connectorSlug: ConnectorSlug;
  readonly username: string | null | undefined;
}): Response {
  const successUrl = new URL("/connector/success", args.origin);
  successUrl.searchParams.set("connectorSlug", args.connectorSlug);
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
          connectorSlug: args.resolvedMethod.connectorSlug,
        },
        signal,
      );
      if (authorization.status === "agentNotFound") {
        return redirectWithError(
          args.origin,
          args.connectorSlug,
          authorization.message,
          true,
        );
      }
    }

    await linkGithubIntegrationAfterConnectorConnect({
      db: set(writeDb$),
      connectorSlug: args.resolvedMethod.connectorSlug,
      identity: args.identity,
      token,
      signal,
    });
    signal.throwIfAborted();

    return successRedirectResponse({
      origin: args.origin,
      connectorSlug: args.connectorSlug,
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
          connectorSlug: args.resolvedMethod.connectorSlug,
        },
        signal,
      );
      if (authorization.status === "agentNotFound") {
        return redirectWithError(
          args.origin,
          args.connectorSlug,
          authorization.message,
          true,
        );
      }
    }

    return successRedirectResponse({
      origin: args.origin,
      connectorSlug: args.connectorSlug,
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
    connectorSlug: args.connectorSlug,
    authMethod: args.storedState.authMethod,
    expectedGrantKind: "auth-code",
    origin: args.origin,
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
    connectorSlug: args.connectorSlug,
    authMethod: args.storedState.authMethod,
    expectedGrantKind: "openid-auth",
    origin: args.origin,
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
      readonly connectorSlug: ConnectorSlug;
      readonly query: ConnectorCallbackQuery;
      readonly origin: string;
      readonly snapshot: ConnectorRuntimeSnapshot;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    const connectorResult = resolveConnectorWithGrant({
      snapshot: args.snapshot,
      connectorSlug: args.connectorSlug,
      grantKind: "openid-auth",
      origin: args.origin,
    });
    if (!connectorResult.ok) {
      return connectorResult.response;
    }
    const state = args.query.state;
    if (!state) {
      return missingStateRedirectResponse(args.origin, args.connectorSlug);
    }

    const claimedState = await claimStoredOAuthStateForCallback({
      db: set(writeDb$),
      connectorSlug: args.connectorSlug,
      origin: args.origin,
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
        connectorSlug: args.connectorSlug,
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
          connectorSlug: args.connectorSlug,
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
      args.connectorSlug,
      "OpenID authorization failed. Please try again.",
      true,
    );
  },
);

function authCodeCallbackPreflight(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly query: ConnectorCallbackQuery;
  readonly request: Request;
  readonly origin: string;
  readonly snapshot: ConnectorRuntimeSnapshot;
}): Response | null {
  const connectorResult = resolveConnectorWithGrant({
    snapshot: args.snapshot,
    connectorSlug: args.connectorSlug,
    grantKind: "auth-code",
    origin: args.origin,
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
      readonly connectorSlug: ConnectorSlug;
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
      connectorSlug: args.connectorSlug,
      origin: args.origin,
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
        args.connectorSlug,
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
      return missingAuthorizationCodeRedirectResponse(
        args.origin,
        args.connectorSlug,
      );
    }

    if (!state) {
      return missingStateRedirectResponse(args.origin, args.connectorSlug);
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
        connectorSlug: args.connectorSlug,
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
          connectorSlug: args.connectorSlug,
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
      args.connectorSlug,
      "OAuth authorization failed. Please try again.",
      true,
    );
  },
);

const callbackConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const { connectorSlug } = get(
      pathParamsOf(connectorsSlugCallbackContract.callback),
    );
    const query = get(queryOf(connectorsSlugCallbackContract.callback));
    const request = get(request$).raw;
    const origin = getConnectorOAuthOrigin(request);
    const snapshot = await loadConnectorRuntimeSnapshot(get(db$));
    signal.throwIfAborted();

    const response = hasOpenIdCallbackFields(query)
      ? await set(
          handleOpenIdConnectorCallback$,
          {
            connectorSlug,
            query,
            origin,
            snapshot,
          },
          signal,
        )
      : await set(
          handleAuthCodeConnectorCallback$,
          {
            connectorSlug,
            query,
            request,
            origin,
            snapshot,
          },
          signal,
        );
    signal.throwIfAborted();

    if (query.responseMode !== "json") {
      return response;
    }

    set(setResHeader$, "Cache-Control", "no-store");
    for (const cookie of response.headers.getSetCookie()) {
      set(setResHeader$, "Set-Cookie", cookie, { append: true });
    }
    return { status: 200 as const, body: callbackResultFromRedirect(response) };
  },
);

export const connectorsSlugCallbackRoutes: readonly RouteEntry[] = [
  {
    route: connectorsSlugCallbackContract.callback,
    handler: callbackConnectorInner$,
  },
];
