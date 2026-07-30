import { command } from "ccstate";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { zeroCustomConnectorOAuth2Contract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { ConnectorOauthCallbackResult } from "@vm0/api-contracts/contracts/connectors-slug-callback";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import {
  claimCustomConnectorOAuthState,
  type StoredOAuthState,
} from "../services/connector-oauth-state.service";
import { validateConnectorAuthorizationTarget$ } from "../services/connected-connector-authorization.service";
import {
  decryptCustomConnectorOAuth2Credentials,
  exchangeCustomConnectorOAuth2Code,
  parseCustomConnectorOAuthStateContext,
  startCustomConnectorOAuth2$,
  storeCustomConnectorOAuth2Connection,
} from "../services/custom-connector-oauth2.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { addUserCustomConnector } from "../services/user-connectors.service";
import { getCustomConnectorById } from "../services/zero-custom-connector.service";
import { tapError } from "../utils";
import type { RouteEntry } from "../route-entry";
import {
  connectorOAuthRedirectResponse,
  clearConnectorOAuthCookies,
} from "./connector-oauth-route-state";
import { env } from "../../lib/env";

const CUSTOM_CONNECTOR_OAUTH_CALLBACK_PATH = "/connectors/custom/callback";

function callbackRedirect(args: {
  readonly origin: string;
  readonly status: "success" | "error";
  readonly message?: string;
}): Response {
  const url = new URL(
    `/connectors/custom/callback/${args.status}`,
    args.origin,
  );
  if (args.message) {
    url.searchParams.set("message", args.message);
  }
  const response = connectorOAuthRedirectResponse(url.toString());
  clearConnectorOAuthCookies(response);
  return response;
}

function callbackError(origin: string, message: string): Response {
  return callbackRedirect({ origin, status: "error", message });
}

function callbackResultFromRedirect(
  response: Response,
): ConnectorOauthCallbackResult {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Custom connector callback response is missing a redirect");
  }
  const url = new URL(location);
  if (url.pathname === "/connectors/custom/callback/success") {
    return { status: "success", username: null };
  }
  if (url.pathname === "/connectors/custom/callback/error") {
    return {
      status: "error",
      message:
        url.searchParams.get("message") ||
        "OAuth authorization failed. Please try again.",
    };
  }
  throw new Error(`Unexpected custom connector callback redirect: ${location}`);
}

const startOAuth2Inner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroCustomConnectorOAuth2Contract.start));
  const body = await get(bodyResultOf(zeroCustomConnectorOAuth2Contract.start));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const featureContext = await get(
    userFeatureSwitchContext(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isFeatureEnabled(FeatureSwitchKey.CustomConnectorOAuth2, featureContext)
  ) {
    return {
      status: 403 as const,
      body: {
        error: {
          message: "Custom connector OAuth 2.0 is not enabled",
          code: "FORBIDDEN" as const,
        },
      },
    };
  }
  if (
    (auth.tokenType === "zero" || body.data.agentId !== undefined) &&
    !isFeatureEnabled(FeatureSwitchKey.CustomConnectorCliCreate, featureContext)
  ) {
    return {
      status: 403 as const,
      body: {
        error: {
          message: "Custom connector CLI creation is not enabled",
          code: "FORBIDDEN" as const,
        },
      },
    };
  }
  const agentTarget = await set(
    validateConnectorAuthorizationTarget$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: body.data.agentId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!agentTarget.ok) {
    return badRequestMessage(agentTarget.message);
  }
  const redirectUri = new URL(
    CUSTOM_CONNECTOR_OAUTH_CALLBACK_PATH,
    env("APP_URL"),
  ).toString();
  const result = await set(
    startCustomConnectorOAuth2$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      connectorId: params.id,
      redirectUri,
      agentId: body.data.agentId,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return result;
  }
  return { status: 200 as const, body: result };
});

function validateClaimedState(storedState: StoredOAuthState):
  | {
      readonly ok: true;
      readonly context: NonNullable<
        ReturnType<typeof parseCustomConnectorOAuthStateContext>
      >;
    }
  | { readonly ok: false } {
  const context = parseCustomConnectorOAuthStateContext(
    storedState.oauthContext,
  );
  if (
    !context ||
    storedState.type !== null ||
    storedState.customConnectorId !== context.connectorId ||
    storedState.connectorRevision !== context.connectorRevision ||
    storedState.authMethod !== "oauth2"
  ) {
    return { ok: false };
  }
  return { ok: true, context };
}

async function authorizeCustomConnectorAgent(args: {
  readonly db: Db;
  readonly state: StoredOAuthState;
  readonly connectorId: string;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  if (!args.state.authorizeAgent || !args.state.agentId) {
    return null;
  }
  const authorization = await addUserCustomConnector(args.db, {
    orgId: args.state.orgId,
    userId: args.state.userId,
    agentId: args.state.agentId,
    customConnectorId: args.connectorId,
  });
  args.signal.throwIfAborted();
  switch (authorization.status) {
    case "added": {
      return null;
    }
    case "agentNotFound": {
      return "OAuth connected, but the requested agent was not found";
    }
    case "customConnectorsNotFound": {
      return "OAuth connected, but the custom connector was not found";
    }
    case "customConnectorsNotConfigured": {
      return "OAuth connected, but the connector could not be authorized";
    }
    case "customConnectorPermissionSelectionRequired": {
      return "OAuth connected, but connector permissions must be selected before authorizing the agent";
    }
    case "invalidCustomConnectorPermissions": {
      return `OAuth connected, but agent authorization failed: ${authorization.message}`;
    }
  }
}

const completeOAuth2Callback$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const query = get(queryOf(zeroCustomConnectorOAuth2Contract.callback));
    const origin = new URL(env("APP_URL")).origin;
    if (!query.state) {
      return callbackError(origin, "Missing OAuth state");
    }
    const claimed = await claimCustomConnectorOAuthState(
      set(writeDb$),
      { state: query.state },
      signal,
    );
    signal.throwIfAborted();
    if (claimed.kind !== "usable") {
      return callbackError(origin, "Invalid OAuth state - please try again");
    }
    if (query.error) {
      return callbackError(origin, query.error_description ?? query.error);
    }
    if (!query.code) {
      return callbackError(origin, "Missing authorization code");
    }
    const authorizationCode = query.code;
    const state = validateClaimedState(claimed.state);
    if (!state.ok) {
      return callbackError(origin, "Invalid OAuth state - please try again");
    }
    const connector = await get(
      getCustomConnectorById({
        orgId: claimed.state.orgId,
        connectorId: state.context.connectorId,
      }),
    );
    signal.throwIfAborted();
    if (
      !connector ||
      connector.authMode !== "oauth" ||
      !connector.oauthConfig ||
      connector.revision !== state.context.connectorRevision
    ) {
      return callbackError(
        origin,
        "Custom connector OAuth configuration changed - please try again",
      );
    }
    const oauthConfig = connector.oauthConfig;
    const featureContext = await get(
      userFeatureSwitchContext(claimed.state.orgId, claimed.state.userId),
    );
    signal.throwIfAborted();
    if (
      claimed.state.authorizeAgent &&
      !isFeatureEnabled(
        FeatureSwitchKey.CustomConnectorCliCreate,
        featureContext,
      )
    ) {
      return callbackError(
        origin,
        "Custom connector CLI creation is not enabled",
      );
    }
    const credentials = await tapError(
      decryptCustomConnectorOAuth2Credentials(connector, featureContext),
    );
    signal.throwIfAborted();
    if (!credentials) {
      return callbackError(origin, "Could not read OAuth client credentials");
    }
    const completed = await tapError(
      (async () => {
        const token = await exchangeCustomConnectorOAuth2Code({
          config: oauthConfig,
          clientSecret: credentials.clientSecret,
          code: authorizationCode,
          codeVerifier: claimed.state.codeVerifier,
          redirectUri: claimed.state.redirectUri,
          signal,
        });
        signal.throwIfAborted();
        await storeCustomConnectorOAuth2Connection({
          db: set(writeDb$),
          orgId: claimed.state.orgId,
          userId: claimed.state.userId,
          connectorId: connector.id,
          token,
          featureContext,
        });
        signal.throwIfAborted();
        return true;
      })(),
    );
    signal.throwIfAborted();
    if (!completed) {
      return callbackError(
        origin,
        "OAuth token exchange failed - please try again",
      );
    }
    const authorizationError = await authorizeCustomConnectorAgent({
      db: set(writeDb$),
      state: claimed.state,
      connectorId: connector.id,
      signal,
    });
    signal.throwIfAborted();
    if (authorizationError) {
      return callbackError(origin, authorizationError);
    }
    return callbackRedirect({ origin, status: "success" });
  },
);

const callbackOAuth2$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(zeroCustomConnectorOAuth2Contract.callback));
  const response = await set(completeOAuth2Callback$, signal);
  signal.throwIfAborted();
  if (query.responseMode !== "json") {
    return response;
  }
  set(setResHeader$, "Cache-Control", "no-store");
  for (const cookie of response.headers.getSetCookie()) {
    set(setResHeader$, "Set-Cookie", cookie, { append: true });
  }
  return { status: 200 as const, body: callbackResultFromRedirect(response) };
});

export const zeroCustomConnectorOAuth2Routes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorOAuth2Contract.start,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:write",
      },
      startOAuth2Inner$,
    ),
  },
  {
    route: zeroCustomConnectorOAuth2Contract.callback,
    handler: callbackOAuth2$,
  },
];
