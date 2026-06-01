import { command, computed } from "ccstate";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorOauthStartContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
  zeroConnectorsSearchContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import type {
  ConnectorAuthMethodId,
  ConnectorType,
} from "@vm0/connectors/connectors";
import {
  getConnectorAuthMethod,
  getConnectorAuthMethodIdsForGrantKind,
} from "@vm0/connectors/connector-utils";
import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { badRequestMessage, notFound } from "../../lib/error";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
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
import { getConnectorOAuthOrigin } from "./connector-oauth-origin";
import { CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS } from "./connector-oauth-route-state";
import {
  buildResolvedConnectorAuthCodeAuthUrl,
  prepareResolvedConnectorAuthCodeStart,
  resolveConnectorAuthCodeStartMethod,
} from "./connector-auth-code-start";

type ResolvedAuthCodeStartMethod = ReturnType<
  typeof resolveConnectorAuthCodeStartMethod
>;

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

function connectorTypeHasAuthCodeGrant(type: ConnectorType): boolean {
  return getConnectorAuthMethodIdsForGrantKind(type, "auth-code").length > 0;
}

function connectorAuthCodeStartErrorMessage(
  type: ConnectorType,
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
      if (!connectorTypeHasAuthCodeGrant(type)) {
        return `${type} connector does not use an auth-code grant`;
      }
      return `${type} connector does not have ${authMethod} auth method`;
    }
    case "wrong_grant_kind": {
      if (!connectorTypeHasAuthCodeGrant(type)) {
        return `${type} connector does not use an auth-code grant`;
      }
      return `${type} ${authMethod} auth method does not use an auth-code grant`;
    }
  }
}

function resolveRequestedAuthCodeStartMethod(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): ResolvedAuthCodeStartMethod {
  const result = resolveConnectorAuthCodeStartMethod(type, authMethod);
  if (result.ok || result.reason === "missing_auth_method") {
    return result;
  }
  return { ok: false, reason: "wrong_grant_kind" };
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
      authMethod: authCodeStartType.authMethod,
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
    route: zeroConnectorOauthStartContract.start,
    handler: authRoute(connectorWriteAuth, startConnectorOauthInner$),
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
