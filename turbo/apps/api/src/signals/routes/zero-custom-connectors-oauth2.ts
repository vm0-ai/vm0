import { command } from "ccstate";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { zeroCustomConnectorOAuth2Contract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { ConnectorOauthCallbackResult } from "@vm0/api-contracts/contracts/connectors-type-callback";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import {
  claimCustomConnectorOAuthState,
  type StoredOAuthState,
} from "../services/connector-oauth-state.service";
import {
  customConnectorOAuthMethodMatchesState,
  decryptCustomConnectorOAuth2Credentials,
  exchangeCustomConnectorOAuth2Code,
  parseCustomConnectorOAuthStateContext,
  startCustomConnectorOAuth2$,
  storeCustomConnectorOAuth2Connection,
} from "../services/custom-connector-oauth2.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import {
  customConnectorOAuth2AuthMethod,
  getCustomConnectorById,
} from "../services/zero-custom-connector.service";
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
    storedState.type !== `custom:${context.connectorId}` ||
    storedState.authMethod !== "oauth2"
  ) {
    return { ok: false };
  }
  return { ok: true, context };
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
    const method = connector
      ? customConnectorOAuth2AuthMethod(connector)
      : null;
    if (
      !connector ||
      !method ||
      !customConnectorOAuthMethodMatchesState(method, state.context.method)
    ) {
      return callbackError(
        origin,
        "Custom connector OAuth configuration changed - please try again",
      );
    }
    const featureContext = await get(
      userFeatureSwitchContext(claimed.state.orgId, claimed.state.userId),
    );
    signal.throwIfAborted();
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
          method,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          code: authorizationCode,
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
      { requireOrganization: true, missingOrganizationStatus: 401 },
      startOAuth2Inner$,
    ),
  },
  {
    route: zeroCustomConnectorOAuth2Contract.callback,
    handler: callbackOAuth2$,
  },
];
