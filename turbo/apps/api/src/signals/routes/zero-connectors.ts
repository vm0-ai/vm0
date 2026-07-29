import { command, computed } from "ccstate";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorNoAuthGrantContract,
  zeroConnectorOpenIdStartContract,
  zeroConnectorOauthContinueContract,
  zeroConnectorOauthStartContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsBySlugContract,
  zeroConnectorsMainContract,
  zeroConnectorsSearchContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import type { PublicConnectorCatalogDetail } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { connectorSlugLegacyInsertOauthStates } from "@vm0/db/compat/connector-slug-legacy-insert";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import {
  badRequestMessage,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  authorizeConnectedConnector$,
  connectorAgentAuthorizationRequested,
  validateConnectorAuthorizationTarget$,
} from "../services/connected-connector-authorization.service";
import {
  connectManualGrantConnector$,
  connectNoAuthConnector$,
  deleteZeroConnectorLocalState$,
  zeroConnectorBySlug,
  zeroConnectorList,
  zeroConnectorScopeDiff,
  zeroConnectorSearch,
} from "../services/zero-connector-data.service";
import {
  connectorActionResolver,
  type ConnectorActionMethodResolution,
  type ConnectorSlugResolution,
} from "../services/connector-action-resolver.service";
import { isConnectorCatalogUnavailableError } from "../services/connector-catalog-reader.service";
import { getConnectorOAuthAuthorizationUrl } from "../services/connector-oauth-state.service";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";
import {
  getConnectorOAuthCallbackUrlForMethod,
  getConnectorOpenIdCallbackOriginForMethod,
} from "./connector-oauth-origin";
import {
  connectorOAuthRedirectResponse,
  CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS,
} from "./connector-oauth-route-state";
import {
  buildConnectorAuthCodeAuthUrlWithMethod,
  prepareConnectorAuthCodeStartWithMethod,
} from "./connector-auth-code-start";
import {
  buildConnectorOpenIdAuthUrlWithMethod,
  prepareConnectorOpenIdAuthStartWithMethod,
} from "./connector-openid-auth-start";

const connectorReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:read",
} as const;

const connectorWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

function connectorUnavailable(connectorSlug: string) {
  return {
    status: 403 as const,
    body: {
      error: {
        message: `${connectorSlug} connector is not available`,
        code: "FORBIDDEN",
      },
    },
  };
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

type ActionGrantKind =
  PublicConnectorCatalogDetail["authMethods"][number]["grantKind"];

function catalogHasGrantKind(
  catalog: PublicConnectorCatalogDetail,
  grantKind: ActionGrantKind,
): boolean {
  return catalog.authMethods.some((method) => {
    return method.grantKind === grantKind;
  });
}

function connectorMethodResolutionError(
  resolution: Exclude<ConnectorActionMethodResolution, { readonly ok: true }>,
  args: {
    readonly connectorSlug: string;
    readonly authMethodId: string;
    readonly expectedGrantKind: ActionGrantKind;
    readonly expectedGrantLabel: string;
    readonly missingGrantWhenAbsent?: boolean;
  },
) {
  switch (resolution.reason) {
    case "unknown_connector": {
      return badRequestMessage(
        `${args.connectorSlug} connector is not supported`,
      );
    }
    case "unknown_auth_method":
    case "wrong_grant_kind": {
      if (
        args.missingGrantWhenAbsent &&
        !catalogHasGrantKind(
          resolution.catalogConnector,
          args.expectedGrantKind,
        )
      ) {
        return badRequestMessage(
          `${args.connectorSlug} connector does not use ${args.expectedGrantLabel}`,
        );
      }
      if (resolution.reason === "unknown_auth_method") {
        return badRequestMessage(
          `${args.connectorSlug} connector does not have ${args.authMethodId} auth method`,
        );
      }
      return badRequestMessage(
        `${args.connectorSlug} ${args.authMethodId} auth method does not use ${args.expectedGrantLabel}`,
      );
    }
    case "hidden_auth_method": {
      return connectorUnavailable(args.connectorSlug);
    }
    case "missing_executable_capability": {
      return internalServerError("Connector execution is not configured");
    }
  }
}

function connectorSlugResolutionError(
  resolution: Exclude<ConnectorSlugResolution, { readonly ok: true }>,
) {
  switch (resolution.reason) {
    case "unknown_connector": {
      return notFound("Connector not found");
    }
    case "missing_executable_capability": {
      return internalServerError("Connector execution is not configured");
    }
  }
}

const getConnectorListInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const result = await get(
    zeroConnectorList({ orgId: auth.orgId, userId: auth.userId }),
  );
  return { status: 200 as const, body: result };
});

const getConnectorBySlugInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroConnectorsBySlugContract.get));
  const resolver = await get(connectorActionResolver());
  const resolved = await resolver.resolveSlug({
    connectorSlug: params.type,
    requireExecutable: false,
  });
  if (!resolved.ok) {
    return connectorSlugResolutionError(resolved);
  }
  const connector = await get(
    zeroConnectorBySlug({
      orgId: auth.orgId,
      userId: auth.userId,
      connectorSlug: resolved.connectorSlug,
      snapshot: resolved.snapshot,
    }),
  );
  if (!connector) {
    return notFound("Connector not found");
  }

  return { status: 200 as const, body: connector };
});

const deleteConnectorBySlugInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroConnectorsBySlugContract.delete));
    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolved = await resolver.resolveSlug({
      connectorSlug: params.type,
      requireExecutable: false,
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      return connectorSlugResolutionError(resolved);
    }
    const deleted = await set(
      deleteZeroConnectorLocalState$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        connectorSlug: resolved.connectorSlug,
        snapshot: resolved.snapshot,
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
  const resolver = await get(connectorActionResolver());
  const resolved = await resolver.resolveSlug({
    connectorSlug: params.type,
    requireExecutable: false,
  });
  if (!resolved.ok) {
    return connectorSlugResolutionError(resolved);
  }
  const diff = await get(
    zeroConnectorScopeDiff({
      orgId: auth.orgId,
      userId: auth.userId,
      connectorSlug: resolved.connectorSlug,
      snapshot: resolved.snapshot,
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
  const connectors = await settle(
    get(
      zeroConnectorSearch({
        orgId: auth.orgId,
        userId: auth.userId,
        keyword: query.keyword,
      }),
    ),
  );
  if (!connectors.ok) {
    if (isConnectorCatalogUnavailableError(connectors.error)) {
      return providerUnavailable(
        "Connector catalog is temporarily unavailable",
      );
    }
    throw connectors.error;
  }
  return {
    status: 200 as const,
    body: { connectors: [...connectors.value] },
  };
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

    const agentTarget = await set(
      validateConnectorAuthorizationTarget$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: bodyResult.data.agentId,
      },
      signal,
    );
    if (!agentTarget.ok) {
      return notFound(agentTarget.message);
    }

    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolved = await resolver.resolveNewActionMethod({
      connectorSlug: params.type,
      authMethodId: bodyResult.data.authMethod,
      expectedGrantKind: "manual",
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      return connectorMethodResolutionError(resolved, {
        connectorSlug: params.type,
        authMethodId: bodyResult.data.authMethod,
        expectedGrantKind: "manual",
        expectedGrantLabel: "a manual grant",
      });
    }

    const result = await set(
      connectManualGrantConnector$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        runtimeMethod: resolved.runtimeMethod,
        snapshot: resolved.snapshot,
        values: bodyResult.data.values,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "invalid") {
      return badRequestMessage(result.message);
    }

    if (connectorAgentAuthorizationRequested(bodyResult.data)) {
      const authorization = await set(
        authorizeConnectedConnector$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          agentId: bodyResult.data.agentId ?? null,
          connectorSlug: resolved.connectorSlug,
        },
        signal,
      );
      if (authorization.status === "agentNotFound") {
        return notFound(authorization.message);
      }
    }

    return { status: 200 as const, body: result.connector };
  },
);

const connectNoAuthConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroConnectorNoAuthGrantContract.connect));
    const bodyResult = await get(
      bodyResultOf(zeroConnectorNoAuthGrantContract.connect),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const agentTarget = await set(
      validateConnectorAuthorizationTarget$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: bodyResult.data.agentId,
      },
      signal,
    );
    if (!agentTarget.ok) {
      return notFound(agentTarget.message);
    }

    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolved = await resolver.resolveNewActionMethod({
      connectorSlug: params.type,
      authMethodId: bodyResult.data.authMethod,
      expectedGrantKind: "none",
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      return connectorMethodResolutionError(resolved, {
        connectorSlug: params.type,
        authMethodId: bodyResult.data.authMethod,
        expectedGrantKind: "none",
        expectedGrantLabel: "a no-auth grant",
      });
    }

    const result = await set(
      connectNoAuthConnector$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        runtimeMethod: resolved.runtimeMethod,
        snapshot: resolved.snapshot,
      },
      signal,
    );
    signal.throwIfAborted();

    if (connectorAgentAuthorizationRequested(bodyResult.data)) {
      const authorization = await set(
        authorizeConnectedConnector$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          agentId: bodyResult.data.agentId ?? null,
          connectorSlug: resolved.connectorSlug,
        },
        signal,
      );
      if (authorization.status === "agentNotFound") {
        return notFound(authorization.message);
      }
    }

    return { status: 200 as const, body: result.connector };
  },
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
    const connectorSlug = params.type;

    if (!auth.orgId) {
      return badRequestMessage(
        "Explicit org context required — ensure active org in session",
      );
    }

    const agentTarget = await set(
      validateConnectorAuthorizationTarget$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: bodyResult.data.agentId,
      },
      signal,
    );
    if (!agentTarget.ok) {
      return badRequestMessage(agentTarget.message);
    }

    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolved = await resolver.resolveNewActionMethod({
      connectorSlug,
      authMethodId: bodyResult.data.authMethod,
      expectedGrantKind: "auth-code",
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      return connectorMethodResolutionError(resolved, {
        connectorSlug,
        authMethodId: bodyResult.data.authMethod,
        expectedGrantKind: "auth-code",
        expectedGrantLabel: "an auth-code grant",
        missingGrantWhenAbsent: true,
      });
    }

    const method = resolved.method;
    if (method.grant.kind !== "auth-code") {
      return internalServerError("Connector execution is not configured");
    }

    const redirectUri = getConnectorOAuthCallbackUrlForMethod({
      request,
      method,
      connectorSlug: resolved.connectorSlug,
      callbackTarget: bodyResult.data.callbackTarget,
    });
    const prepared = prepareConnectorAuthCodeStartWithMethod({
      method,
      redirectUri,
      readEnv: optionalEnv,
    });
    if (!prepared.ok) {
      return internalServerError(`${connectorSlug} auth client not configured`);
    }
    const authResult = await buildConnectorAuthCodeAuthUrlWithMethod({
      connectorSlug: resolved.connectorSlug,
      authMethodId: resolved.authMethodId,
      method,
      authClient: prepared.authClient,
      redirectUri: prepared.redirectUri,
      state: prepared.state,
    });
    signal.throwIfAborted();

    await set(
      deleteZeroConnectorLocalState$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        connectorSlug: resolved.connectorSlug,
        snapshot: resolved.snapshot,
      },
      signal,
    );
    signal.throwIfAborted();

    const writeDb = set(writeDb$);
    await writeDb.insert(connectorSlugLegacyInsertOauthStates).values({
      state: prepared.state,
      type: resolved.connectorSlug,
      authMethod: resolved.authMethodId,
      userId: auth.userId,
      orgId: auth.orgId,
      agentId: bodyResult.data.agentId,
      authorizeAgent: connectorAgentAuthorizationRequested(bodyResult.data),
      redirectUri: prepared.redirectUri,
      authorizationUrl: authResult.url,
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

// Compatibility for handoff URLs issued before direct provider redirects.
// Remove after the previous API is no longer rollback-eligible and every state
// issued with CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS has expired.
const continueConnectorOauthInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    const params = get(
      pathParamsOf(zeroConnectorOauthContinueContract.continue),
    );
    const query = get(queryOf(zeroConnectorOauthContinueContract.continue));
    const resolution = await getConnectorOAuthAuthorizationUrl(
      get(db$),
      { state: query.state, connectorSlug: params.type },
      signal,
    );

    if (resolution.kind !== "usable") {
      return notFound("OAuth handoff not found");
    }

    const response = connectorOAuthRedirectResponse(
      resolution.authorizationUrl,
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  },
);

const startConnectorOpenIdInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParamsOf(zeroConnectorOpenIdStartContract.start));
    const bodyResult = await get(
      bodyResultOf(zeroConnectorOpenIdStartContract.start),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const request = get(request$).raw;
    const auth = get(authContext$);
    const connectorSlug = params.type;

    if (!auth.orgId) {
      return badRequestMessage(
        "Explicit org context required — ensure active org in session",
      );
    }

    const agentTarget = await set(
      validateConnectorAuthorizationTarget$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: bodyResult.data.agentId,
      },
      signal,
    );
    if (!agentTarget.ok) {
      return badRequestMessage(agentTarget.message);
    }

    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolved = await resolver.resolveNewActionMethod({
      connectorSlug,
      authMethodId: bodyResult.data.authMethod,
      expectedGrantKind: "openid-auth",
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      return connectorMethodResolutionError(resolved, {
        connectorSlug,
        authMethodId: bodyResult.data.authMethod,
        expectedGrantKind: "openid-auth",
        expectedGrantLabel: "an OpenID auth grant",
        missingGrantWhenAbsent: true,
      });
    }

    if (resolved.method.grant.kind !== "openid-auth") {
      return internalServerError("Connector execution is not configured");
    }

    const prepared = prepareConnectorOpenIdAuthStartWithMethod({
      connectorSlug: resolved.connectorSlug,
      method: resolved.method,
      origin: getConnectorOpenIdCallbackOriginForMethod({
        request,
        method: resolved.method,
      }),
    });
    const authResult = await buildConnectorOpenIdAuthUrlWithMethod({
      connectorSlug: resolved.connectorSlug,
      authMethodId: resolved.authMethodId,
      method: resolved.method,
      returnTo: prepared.returnTo,
      realm: prepared.realm,
      state: prepared.state,
    });
    signal.throwIfAborted();

    await set(
      deleteZeroConnectorLocalState$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        connectorSlug: resolved.connectorSlug,
        snapshot: resolved.snapshot,
      },
      signal,
    );
    signal.throwIfAborted();

    const writeDb = set(writeDb$);
    await writeDb.insert(connectorSlugLegacyInsertOauthStates).values({
      state: prepared.state,
      type: resolved.connectorSlug,
      authMethod: resolved.authMethodId,
      userId: auth.userId,
      orgId: auth.orgId,
      agentId: bodyResult.data.agentId,
      authorizeAgent: connectorAgentAuthorizationRequested(bodyResult.data),
      redirectUri: prepared.expectedReturnTo,
      codeVerifier: authResult.codeVerifier,
      oauthContext: JSON.stringify({ realm: prepared.realm }),
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

export const zeroConnectorsRoutes: readonly RouteEntry[] = [
  {
    route: zeroConnectorManualGrantContract.connect,
    handler: authRoute(connectorWriteAuth, connectManualGrantConnectorInner$),
  },
  {
    route: zeroConnectorNoAuthGrantContract.connect,
    handler: authRoute(connectorWriteAuth, connectNoAuthConnectorInner$),
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
    route: zeroConnectorOauthStartContract.start,
    handler: authRoute(connectorWriteAuth, startConnectorOauthInner$),
  },
  {
    route: zeroConnectorOauthContinueContract.continue,
    handler: continueConnectorOauthInner$,
  },
  {
    route: zeroConnectorOpenIdStartContract.start,
    handler: authRoute(connectorWriteAuth, startConnectorOpenIdInner$),
  },
  {
    route: zeroConnectorsBySlugContract.get,
    handler: authRoute(connectorReadAuth, getConnectorBySlugInner$),
  },
  {
    route: zeroConnectorsBySlugContract.delete,
    handler: authRoute(connectorWriteAuth, deleteConnectorBySlugInner$),
  },
];
