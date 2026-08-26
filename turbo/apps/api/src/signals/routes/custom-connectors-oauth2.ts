import { command } from "ccstate";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { customConnectorOAuth2Contract } from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorOauthCallbackResult } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { appUrlForPublicBrand } from "@okouai/core/public-brand";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { publicBrand$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import {
  claimConnectorOAuthState,
  getConnectorOAuthStateStatus,
  type StoredCustomConnectorOAuthState,
} from "../services/connector-oauth-state.service";
import { validateConnectorAuthorizationTarget$ } from "../services/connected-connector-authorization.service";
import {
  customConnectorOAuth2EffectiveInitialToken as effectiveInitialToken,
  customConnectorOAuthStateMatchesDefinition,
  decryptCustomConnectorOAuth2Credentials,
  exchangeCustomConnectorOAuth2Code,
  parseValidCustomConnectorOAuthState,
  startCustomConnectorOAuth2$,
  storeCustomConnectorOAuth2Connection,
  type OAuthTokenResult,
} from "../services/custom-connector-oauth2.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { addUserCustomConnector } from "../services/user-connectors.service";
import { commitConnectorRuntimeMutation } from "../services/connector-runtime-wakeup.service";
import { publishCustomConnectorUserInvalidationAfterCommit as publishCustomUserInvalidation } from "../services/connector-client-invalidation.service";
import { isCustomConnectorMcpEnabled } from "../services/custom-connector-mcp-feature.service";
import {
  getCustomConnectorById,
  type CustomConnectorOAuthConfigRow,
  type CustomConnectorRow,
} from "../services/custom-connector.service";
import { tapError } from "../utils";
import type { RouteEntry } from "../route-entry";
import {
  connectorOAuthRedirectResponse,
  clearConnectorOAuthCookies,
} from "../../lib/connector-oauth-state";
import { env } from "../../lib/env";
import { connectorConnectionWriteFailureMessage } from "../services/connector-data.service";

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

function appOriginForPublicBrand(publicBrand: "vm0" | "okou"): string {
  return new URL(appUrlForPublicBrand(env("APP_URL"), publicBrand)).origin;
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
  const params = get(pathParamsOf(customConnectorOAuth2Contract.start));
  const body = await get(bodyResultOf(customConnectorOAuth2Contract.start));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
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
      publicBrand: get(publicBrand$),
      agentId: body.data.agentId,
      account: body.data.account,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return result;
  }
  return { status: 200 as const, body: result };
});

function validateClaimedState(storedState: StoredCustomConnectorOAuthState):
  | {
      readonly ok: true;
      readonly context: NonNullable<
        ReturnType<typeof parseValidCustomConnectorOAuthState>
      >;
    }
  | { readonly ok: false } {
  const context = parseValidCustomConnectorOAuthState(storedState);
  if (!context) {
    return { ok: false };
  }
  return { ok: true, context };
}

function isCurrentOAuthCustomConnector(
  connector: CustomConnectorRow | null,
  context: NonNullable<ReturnType<typeof parseValidCustomConnectorOAuthState>>,
): connector is CustomConnectorRow & {
  readonly authMode: "oauth";
  readonly oauthConfig: CustomConnectorOAuthConfigRow;
} {
  return Boolean(
    connector &&
    connector.authMode === "oauth" &&
    connector.oauthConfig &&
    customConnectorOAuthStateMatchesDefinition(context, connector),
  );
}

async function authorizeCustomConnectorAgent(
  args: {
    readonly db: Db;
    readonly state: StoredCustomConnectorOAuthState;
    readonly connectorId: string;
  },
  signal: AbortSignal,
): Promise<string | null> {
  if (!args.state.authorizeAgent || !args.state.agentId) {
    return null;
  }
  const authorization = await addUserCustomConnector(args.db, {
    orgId: args.state.orgId,
    userId: args.state.userId,
    agentId: args.state.agentId,
    customConnectorId: args.connectorId,
  });
  signal.throwIfAborted();
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
    case "customConnectorPermissionSelectionRequired": {
      return "OAuth connected, but connector permissions must be selected before authorizing the agent";
    }
    case "invalidCustomConnectorPermissions": {
      return `OAuth connected, but agent authorization failed: ${authorization.message}`;
    }
    case "mcpFeatureDisabled": {
      return "OAuth connected, but MCP custom connector management is not enabled";
    }
  }
}

async function persistCustomConnectorOAuth2Connection(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly storageVersion: number;
    readonly token: OAuthTokenResult;
    readonly featureContext: FeatureSwitchContext;
    readonly account: ConnectorAccountMutationIntent;
    readonly insertConnectionId?: string;
  },
  signal: AbortSignal,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
> {
  const connectionStorage = storeCustomConnectorOAuth2Connection(args, signal);
  const result = await commitConnectorRuntimeMutation(connectionStorage, () => {
    return {
      db: args.db,
      scope: { orgId: args.orgId, userId: args.userId },
      targets: [{ kind: "custom", customConnectorId: args.connectorId }],
    };
  });
  if (result.kind !== "stored") {
    const status =
      result.kind === "missing"
        ? "accountNotFound"
        : result.kind === "ambiguous"
          ? "accountAmbiguous"
          : "siblingDisabled";
    return {
      ok: false,
      message: connectorConnectionWriteFailureMessage(status),
    };
  }
  await publishCustomUserInvalidation(args.userId, signal);
  return { ok: true };
}

function customConnectorOAuthPersistenceFailure(
  result:
    | Awaited<ReturnType<typeof persistCustomConnectorOAuth2Connection>>
    | undefined,
): string | null {
  if (!result) {
    return "OAuth token exchange failed - please try again";
  }
  return result.ok ? null : result.message;
}

async function codeLessCustomOAuthCallbackResponse(
  args: { readonly db: Db; readonly origin: string; readonly state: string },
  signal: AbortSignal,
): Promise<Response> {
  const status = await getConnectorOAuthStateStatus(
    args.db,
    { state: args.state, target: { kind: "custom" } },
    signal,
  );
  signal.throwIfAborted();
  return status.kind === "usable"
    ? callbackError(
        appOriginForPublicBrand(status.publicBrand),
        "Missing authorization code",
      )
    : callbackError(args.origin, "Invalid OAuth state - please try again");
}

const completeOAuth2Callback$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const query = get(queryOf(customConnectorOAuth2Contract.callback));
    const defaultOrigin = new URL(env("APP_URL")).origin;
    const oauthState = query.state;
    const authorizationCode = query.code ?? "";
    const providerError = query.error;
    if (!oauthState) {
      return callbackError(defaultOrigin, "Missing OAuth state");
    }
    if (!providerError && !authorizationCode) {
      return await codeLessCustomOAuthCallbackResponse(
        { db: set(writeDb$), origin: defaultOrigin, state: oauthState },
        signal,
      );
    }
    const claimed = await claimConnectorOAuthState(
      set(writeDb$),
      { state: oauthState, target: { kind: "custom" } },
      signal,
    );
    signal.throwIfAborted();
    if (claimed.kind !== "usable") {
      return callbackError(
        defaultOrigin,
        "Invalid OAuth state - please try again",
      );
    }
    const origin = appOriginForPublicBrand(claimed.state.publicBrand);
    if (providerError) {
      return callbackError(origin, query.error_description ?? providerError);
    }
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
    if (!isCurrentOAuthCustomConnector(connector, state.context)) {
      return callbackError(
        origin,
        "Custom connector OAuth configuration changed - please try again",
      );
    }
    const oauthConfig = connector.oauthConfig;
    if (oauthConfig.providerAdapter !== "standard") {
      return callbackError(
        origin,
        "OAuth callback was sent to the wrong connector endpoint",
      );
    }
    const featureContext = await get(
      userFeatureSwitchContext(claimed.state.orgId, claimed.state.userId),
    );
    signal.throwIfAborted();
    if (
      connector.kind === "mcp" &&
      !isCustomConnectorMcpEnabled(featureContext)
    ) {
      return callbackError(
        origin,
        "MCP custom connector management is not enabled",
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
        const token = await exchangeCustomConnectorOAuth2Code(
          {
            config: oauthConfig,
            clientSecret: credentials.clientSecret,
            code: authorizationCode,
            codeVerifier: claimed.state.codeVerifier,
            redirectUri: claimed.state.redirectUri,
          },
          signal,
        );
        signal.throwIfAborted();
        return await persistCustomConnectorOAuth2Connection(
          {
            db: set(writeDb$),
            orgId: claimed.state.orgId,
            userId: claimed.state.userId,
            connectorId: connector.id,
            storageVersion: connector.storageVersion,
            token: effectiveInitialToken(token, claimed.state.authorizationUrl),
            featureContext,
            account: claimed.state.accountMutation,
            insertConnectionId:
              claimed.state.accountMutation.intent === "add"
                ? claimed.state.id
                : undefined,
          },
          signal,
        );
      })(),
    );
    signal.throwIfAborted();
    const persistenceFailure =
      customConnectorOAuthPersistenceFailure(completed);
    if (persistenceFailure) {
      return callbackError(origin, persistenceFailure);
    }
    const authorizationError = await authorizeCustomConnectorAgent(
      {
        db: set(writeDb$),
        state: claimed.state,
        connectorId: connector.id,
      },
      signal,
    );
    signal.throwIfAborted();
    if (authorizationError) {
      return callbackError(origin, authorizationError);
    }
    return callbackRedirect({ origin, status: "success" });
  },
);

const callbackOAuth2$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(customConnectorOAuth2Contract.callback));
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

export const customConnectorOAuth2Routes: readonly RouteEntry[] = [
  {
    route: customConnectorOAuth2Contract.start,
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
    route: customConnectorOAuth2Contract.callback,
    handler: callbackOAuth2$,
  },
];
