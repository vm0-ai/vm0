import { command } from "ccstate";
import { and, eq, ne } from "drizzle-orm";
import { zeroFeishuOauthContract } from "@vm0/api-contracts/contracts/zero-feishu-oauth";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import {
  fetchFeishuUserInfo,
  type FeishuUserInfo,
} from "../external/feishu-client";
import { nowDate } from "../external/time";
import type { RouteEntry } from "../route-entry";
import {
  claimCustomConnectorOAuthState,
  readCustomConnectorOAuthState,
  type StoredOAuthState,
} from "../services/connector-oauth-state.service";
import {
  decryptCustomConnectorOAuth2Credentials,
  exchangeCustomConnectorOAuth2Code,
  parseCustomConnectorOAuthStateContext,
  startCustomConnectorOAuth2$,
  storeCustomConnectorOAuth2Connection,
  type CustomConnectorOAuthStateContext,
  type OAuthTokenResult,
} from "../services/custom-connector-oauth2.service";
import { ensureFeishuCustomConnector$ } from "../services/feishu-custom-connector.service";
import {
  feishuBotOpenUrl,
  feishuOAuthAppCallbackUrl,
  feishuOAuthCallbackUrl,
  loadFeishuInstallationConfig,
} from "../services/feishu-config";
import {
  type FeishuOAuthState,
  verifyFeishuOAuthState,
} from "../services/feishu-oauth-state";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { addUserCustomConnector } from "../services/user-connectors.service";
import {
  getCustomConnectorById,
  type CustomConnectorRow,
} from "../services/zero-custom-connector.service";
import { publishFeishuOrgChanged } from "../services/zero-feishu-realtime.service";
import { notifyFeishuConnect } from "../services/zero-feishu-welcome.service";
import { tapError } from "../utils";

const L = logger("FeishuOAuth");
const REDIRECT_STATUS = 307;

interface FeishuOAuthCallbackQuery {
  readonly code?: string;
  readonly error?: string;
  readonly error_description?: string;
  readonly responseMode?: "json";
  readonly state?: string;
}

interface FeishuConnectionState {
  readonly installationId: string;
  readonly orgId: string;
  readonly userId: string;
}

interface FeishuInstallationOAuthRow {
  readonly appId: string;
  readonly tenantKey: string | null;
  readonly setupCompletedAt: Date | null;
  readonly ownerUserId: string | null;
  readonly defaultAgentId: string;
}

type FeishuOAuthCompletionTarget = "custom" | "feishu";
type FeishuCustomConnectorOAuthContext = Omit<
  CustomConnectorOAuthStateContext,
  "providerContext"
> & {
  readonly providerContext: NonNullable<
    CustomConnectorOAuthStateContext["providerContext"]
  >;
};

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url, "Cache-Control": "no-store" },
  });
}

function jsonErrorResponse(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

function settingsUrl(params: Readonly<Record<string, string>>): string {
  const url = new URL("/settings/feishu", env("APP_URL"));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function settingsRedirect(params: Readonly<Record<string, string>>): Response {
  return redirectResponse(settingsUrl(params));
}

function customConnectorCallbackUrl(
  status: "error" | "success",
  message?: string,
): string {
  const url = new URL(`/connectors/custom/callback/${status}`, env("APP_URL"));
  if (message) {
    url.searchParams.set("message", message);
  }
  return url.toString();
}

function completionErrorUrl(
  target: FeishuOAuthCompletionTarget,
  message: string,
): string {
  return target === "custom"
    ? customConnectorCallbackUrl("error", message)
    : settingsUrl({ error: message });
}

function appCallbackUrl(query: FeishuOAuthCallbackQuery): string {
  const url = new URL(feishuOAuthAppCallbackUrl());
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function oauthRedirectUri(target: "app" | undefined): string {
  return target === "app"
    ? feishuOAuthAppCallbackUrl()
    : feishuOAuthCallbackUrl();
}

function callbackRedirectResponse(
  url: string,
  responseMode: "json" | undefined,
):
  | Response
  | {
      readonly status: 200;
      readonly body: { readonly redirectUrl: string };
    } {
  if (responseMode === "json") {
    return {
      status: 200,
      body: { redirectUrl: url },
    };
  }
  return redirectResponse(url);
}

function validCustomFeishuState(
  storedState: StoredOAuthState,
): FeishuCustomConnectorOAuthContext | null {
  const context = parseCustomConnectorOAuthStateContext(
    storedState.oauthContext,
  );
  if (
    !context?.providerContext ||
    context.providerContext.provider !== "feishu" ||
    storedState.type !== null ||
    storedState.customConnectorId !== context.connectorId ||
    storedState.connectorRevision !== context.connectorRevision ||
    storedState.authMethod !== "oauth2"
  ) {
    return null;
  }
  return { ...context, providerContext: context.providerContext };
}

async function exchangeOAuthTokenAndUserInfo(args: {
  readonly connector: CustomConnectorRow;
  readonly clientSecret: string;
  readonly code: string;
  readonly codeVerifier: string | null;
  readonly redirectUri: string;
  readonly installationId: string;
  readonly signal: AbortSignal;
}): Promise<
  | {
      readonly token: OAuthTokenResult;
      readonly userInfo: FeishuUserInfo;
    }
  | undefined
> {
  const oauthConfig = args.connector.oauthConfig;
  if (!oauthConfig) {
    return undefined;
  }
  return await tapError(
    (async () => {
      const token = await exchangeCustomConnectorOAuth2Code({
        config: oauthConfig,
        clientSecret: args.clientSecret,
        code: args.code,
        codeVerifier: args.codeVerifier,
        redirectUri: args.redirectUri,
        signal: args.signal,
      });
      args.signal.throwIfAborted();
      const userInfo = await fetchFeishuUserInfo({
        userAccessToken: token.accessToken,
        signal: args.signal,
      });
      return { token, userInfo };
    })(),
    (error) => {
      L.error("Feishu OAuth exchange failed", {
        error,
        installationId: args.installationId,
      });
    },
  );
}

async function upsertFeishuConnection(args: {
  readonly db: Db;
  readonly state: FeishuConnectionState;
  readonly userInfo: FeishuUserInfo;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly connected: false }
  | {
      readonly connected: true;
      readonly connectionId: string;
      readonly shouldNotify: boolean;
    }
> {
  const [existing] = await args.db
    .select({
      id: feishuOrgConnections.id,
      vm0UserId: feishuOrgConnections.vm0UserId,
      dmWelcomeSent: feishuOrgConnections.dmWelcomeSent,
    })
    .from(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.installationId, args.state.installationId),
        eq(feishuOrgConnections.feishuOpenId, args.userInfo.openId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (existing && existing.vm0UserId !== args.state.userId) {
    return { connected: false };
  }

  let connectionId: string;
  let shouldNotify: boolean;
  if (existing) {
    await args.db
      .update(feishuOrgConnections)
      .set({
        feishuUserName: args.userInfo.name,
        updatedAt: nowDate(),
      })
      .where(eq(feishuOrgConnections.id, existing.id));
    connectionId = existing.id;
    shouldNotify = !existing.dmWelcomeSent;
  } else {
    const [inserted] = await args.db
      .insert(feishuOrgConnections)
      .values({
        installationId: args.state.installationId,
        feishuOpenId: args.userInfo.openId,
        vm0UserId: args.state.userId,
        feishuUserName: args.userInfo.name,
      })
      .onConflictDoNothing({
        target: [
          feishuOrgConnections.feishuOpenId,
          feishuOrgConnections.installationId,
        ],
      })
      .returning({
        id: feishuOrgConnections.id,
        dmWelcomeSent: feishuOrgConnections.dmWelcomeSent,
      });
    args.signal.throwIfAborted();
    if (!inserted) {
      return { connected: false };
    }
    connectionId = inserted.id;
    shouldNotify = !inserted.dmWelcomeSent;
  }

  await args.db
    .delete(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.installationId, args.state.installationId),
        eq(feishuOrgConnections.vm0UserId, args.state.userId),
        ne(feishuOrgConnections.feishuOpenId, args.userInfo.openId),
      ),
    );
  args.signal.throwIfAborted();
  return { connected: true, connectionId, shouldNotify };
}

async function loadInstallationForConnector(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly appId: string;
  readonly installationId?: string;
}): Promise<
  (FeishuInstallationOAuthRow & { readonly installationId: string }) | null
> {
  const conditions = [
    eq(feishuOrgInstallations.orgId, args.orgId),
    eq(feishuOrgInstallations.appId, args.appId),
  ];
  if (args.installationId) {
    conditions.push(eq(feishuOrgInstallations.id, args.installationId));
  }
  const [installation] = await args.db
    .select({
      installationId: feishuOrgInstallations.id,
      appId: feishuOrgInstallations.appId,
      tenantKey: feishuOrgInstallations.feishuTenantKey,
      setupCompletedAt: feishuOrgInstallations.setupCompletedAt,
      ownerUserId: feishuOrgInstallations.ownerUserId,
      defaultAgentId: feishuOrgInstallations.defaultComposeId,
    })
    .from(feishuOrgInstallations)
    .where(and(...conditions))
    .limit(1);
  return installation ?? null;
}

async function persistFeishuOAuthConnection(args: {
  readonly db: Db;
  readonly state: FeishuConnectionState;
  readonly installation: FeishuInstallationOAuthRow;
  readonly connector: CustomConnectorRow;
  readonly token: OAuthTokenResult;
  readonly userInfo: FeishuUserInfo;
  readonly featureContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly connected: false }
  | {
      readonly connected: true;
      readonly connectionId: string;
      readonly shouldNotify: boolean;
    }
> {
  return await args.db.transaction(async (tx) => {
    const connection = await upsertFeishuConnection({
      db: tx,
      state: args.state,
      userInfo: args.userInfo,
      signal: args.signal,
    });
    if (!connection.connected) {
      return connection;
    }
    await storeCustomConnectorOAuth2Connection({
      db: tx,
      orgId: args.state.orgId,
      userId: args.state.userId,
      connectorId: args.connector.id,
      token: args.token,
      featureContext: args.featureContext,
    });
    args.signal.throwIfAborted();
    if (!args.installation.tenantKey && args.userInfo.tenantKey) {
      await tx
        .update(feishuOrgInstallations)
        .set({
          feishuTenantKey: args.userInfo.tenantKey,
          updatedAt: nowDate(),
        })
        .where(eq(feishuOrgInstallations.id, args.state.installationId));
    }
    const grant = await addUserCustomConnector(tx, {
      orgId: args.state.orgId,
      userId: args.state.userId,
      agentId: args.installation.defaultAgentId,
      customConnectorId: args.connector.id,
    });
    if (grant.status !== "added") {
      throw new Error(
        `Failed to authorize Feishu custom connector: ${grant.status}`,
      );
    }
    args.signal.throwIfAborted();
    return connection;
  });
}

async function finishFeishuOAuthConnection(args: {
  readonly db: Db;
  readonly state: FeishuConnectionState;
  readonly installation: FeishuInstallationOAuthRow;
  readonly connector: CustomConnectorRow;
  readonly token: OAuthTokenResult;
  readonly userInfo: FeishuUserInfo;
  readonly expectedOpenId?: string;
  readonly featureContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<
  "account_in_use" | "connected" | "identity_mismatch" | "tenant_mismatch"
> {
  if (args.expectedOpenId && args.expectedOpenId !== args.userInfo.openId) {
    return "identity_mismatch";
  }
  if (
    args.installation.tenantKey &&
    args.userInfo.tenantKey &&
    args.installation.tenantKey !== args.userInfo.tenantKey
  ) {
    return "tenant_mismatch";
  }
  const connection = await persistFeishuOAuthConnection(args);
  args.signal.throwIfAborted();
  if (!connection.connected) {
    return "account_in_use";
  }

  await publishFeishuOrgChanged(
    args.db,
    args.state.orgId,
    args.installation.ownerUserId,
    [args.state.userId],
  );
  args.signal.throwIfAborted();
  if (connection.shouldNotify) {
    const backgroundSignal = new AbortController().signal;
    waitUntil(
      tapError(
        notifyFeishuConnect({
          db: args.db,
          installationId: args.state.installationId,
          connectionId: connection.connectionId,
          openId: args.userInfo.openId,
          signal: backgroundSignal,
        }),
        (error) => {
          L.warn("Failed to send Feishu connect welcome", {
            error,
            installationId: args.state.installationId,
            openId: args.userInfo.openId,
          });
        },
      ),
    );
  }
  return "connected";
}

function connectionErrorMessage(
  result: Exclude<
    Awaited<ReturnType<typeof finishFeishuOAuthConnection>>,
    "connected"
  >,
): string {
  switch (result) {
    case "account_in_use": {
      return "This Feishu account is already connected.";
    }
    case "identity_mismatch": {
      return "Use the Feishu account that opened this connect link.";
    }
    case "tenant_mismatch": {
      return "Use an account from the Feishu tenant connected to this workspace.";
    }
  }
}

const connect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(zeroFeishuOauthContract.connect));
  const state = query.state ? verifyFeishuOAuthState(query.state) : null;
  if (!state) {
    return jsonErrorResponse("Invalid or expired connect state");
  }
  const db = set(writeDb$);
  const [installation] = await db
    .select({ setupCompletedAt: feishuOrgInstallations.setupCompletedAt })
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.id, state.installationId),
        eq(feishuOrgInstallations.orgId, state.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!installation) {
    return jsonErrorResponse("Feishu bot not found");
  }
  if (!installation.setupCompletedAt) {
    return settingsRedirect({
      error: "Finish setting up this Feishu bot before connecting.",
    });
  }
  const connectorId = await set(
    ensureFeishuCustomConnector$,
    {
      orgId: state.orgId,
      userId: state.userId,
      installationId: state.installationId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!connectorId) {
    return jsonErrorResponse("Feishu connector not found");
  }
  const result = await set(
    startCustomConnectorOAuth2$,
    {
      orgId: state.orgId,
      userId: state.userId,
      connectorId,
      redirectUri: oauthRedirectUri(query.callbackTarget),
      feishuContext: {
        completionTarget: "feishu",
        installationId: state.installationId,
      },
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return jsonErrorResponse(result.body.error.message);
  }
  return redirectResponse(result.authorizationUrl);
});

const completeLegacyFeishuOAuth$ = command(
  async (
    { get, set },
    args: {
      readonly db: Db;
      readonly query: FeishuOAuthCallbackQuery;
      readonly state: FeishuOAuthState;
    },
    signal: AbortSignal,
  ) => {
    const { db, query, state } = args;
    const target: FeishuOAuthCompletionTarget = "feishu";
    if (query.error) {
      return callbackRedirectResponse(
        completionErrorUrl(target, query.error_description ?? query.error),
        query.responseMode,
      );
    }
    if (!query.code) {
      return jsonErrorResponse("Missing authorization code");
    }
    const config = await loadFeishuInstallationConfig(db, state.installationId);
    signal.throwIfAborted();
    if (!config || config.orgId !== state.orgId) {
      return callbackRedirectResponse(
        completionErrorUrl(target, "Feishu bot not found."),
        query.responseMode,
      );
    }
    const installation = await loadInstallationForConnector({
      db,
      orgId: state.orgId,
      appId: config.appId,
      installationId: state.installationId,
    });
    signal.throwIfAborted();
    if (!installation?.setupCompletedAt) {
      return callbackRedirectResponse(
        completionErrorUrl(
          target,
          "Finish setting up this Feishu bot before connecting.",
        ),
        query.responseMode,
      );
    }
    const connectorId = await set(
      ensureFeishuCustomConnector$,
      {
        orgId: state.orgId,
        userId: state.userId,
        installationId: state.installationId,
      },
      signal,
    );
    if (!connectorId) {
      return callbackRedirectResponse(
        completionErrorUrl(target, "Feishu connector not found."),
        query.responseMode,
      );
    }
    const connector = await get(
      getCustomConnectorById({
        orgId: state.orgId,
        connectorId,
      }),
    );
    signal.throwIfAborted();
    if (
      !connector?.oauthConfig ||
      connector.oauthConfig.providerAdapter !== "feishu"
    ) {
      return callbackRedirectResponse(
        completionErrorUrl(target, "Feishu connector is unavailable."),
        query.responseMode,
      );
    }
    const exchanged = await exchangeOAuthTokenAndUserInfo({
      connector,
      clientSecret: config.appSecret,
      code: query.code,
      codeVerifier: null,
      redirectUri: oauthRedirectUri(state.oauthRedirectTarget),
      installationId: state.installationId,
      signal,
    });
    signal.throwIfAborted();
    if (!exchanged) {
      return callbackRedirectResponse(
        completionErrorUrl(
          target,
          "Failed to connect Feishu account. Please try again.",
        ),
        query.responseMode,
      );
    }
    const featureContext = await get(
      userFeatureSwitchContext(state.orgId, state.userId),
    );
    signal.throwIfAborted();
    const completed = await finishFeishuOAuthConnection({
      db,
      state,
      installation,
      connector,
      ...exchanged,
      featureContext,
      signal,
    });
    if (completed !== "connected") {
      return callbackRedirectResponse(
        completionErrorUrl(target, connectionErrorMessage(completed)),
        query.responseMode,
      );
    }
    return callbackRedirectResponse(
      feishuBotOpenUrl(installation.appId),
      query.responseMode,
    );
  },
);

const completeClaimedCustomFeishuOAuth$ = command(
  async (
    { get },
    args: {
      readonly db: Db;
      readonly query: FeishuOAuthCallbackQuery & { readonly state: string };
      readonly state: StoredOAuthState;
      readonly context: FeishuCustomConnectorOAuthContext;
    },
    signal: AbortSignal,
  ) => {
    const { context, db, query, state } = args;
    const target = context.providerContext.completionTarget;
    if (query.error) {
      return callbackRedirectResponse(
        completionErrorUrl(target, query.error_description ?? query.error),
        query.responseMode,
      );
    }
    if (!query.code) {
      return jsonErrorResponse("Missing authorization code");
    }

    const connector = await get(
      getCustomConnectorById({
        orgId: state.orgId,
        connectorId: context.connectorId,
      }),
    );
    signal.throwIfAborted();
    if (
      !connector?.oauthConfig ||
      connector.oauthConfig.providerAdapter !== "feishu" ||
      connector.revision !== context.connectorRevision
    ) {
      return callbackRedirectResponse(
        completionErrorUrl(
          target,
          "Feishu connector configuration changed. Please try again.",
        ),
        query.responseMode,
      );
    }
    const installation = await loadInstallationForConnector({
      db,
      orgId: state.orgId,
      appId: connector.oauthConfig.clientId,
      installationId: context.providerContext.installationId,
    });
    signal.throwIfAborted();
    if (!installation?.setupCompletedAt) {
      return callbackRedirectResponse(
        completionErrorUrl(
          target,
          "Finish setting up this Feishu bot before connecting.",
        ),
        query.responseMode,
      );
    }
    const featureContext = await get(
      userFeatureSwitchContext(state.orgId, state.userId),
    );
    signal.throwIfAborted();
    const credentials = await tapError(
      decryptCustomConnectorOAuth2Credentials(connector, featureContext),
    );
    signal.throwIfAborted();
    if (!credentials) {
      return callbackRedirectResponse(
        completionErrorUrl(
          target,
          "Could not read Feishu OAuth client credentials.",
        ),
        query.responseMode,
      );
    }
    const exchanged = await exchangeOAuthTokenAndUserInfo({
      connector,
      clientSecret: credentials.clientSecret,
      code: query.code,
      codeVerifier: state.codeVerifier,
      redirectUri: state.redirectUri,
      installationId: installation.installationId,
      signal,
    });
    signal.throwIfAborted();
    if (!exchanged) {
      return callbackRedirectResponse(
        completionErrorUrl(
          target,
          "Failed to connect Feishu account. Please try again.",
        ),
        query.responseMode,
      );
    }
    const connectionState: FeishuConnectionState = {
      installationId: installation.installationId,
      orgId: args.state.orgId,
      userId: args.state.userId,
    };
    const completed = await finishFeishuOAuthConnection({
      db,
      state: connectionState,
      installation,
      connector,
      ...exchanged,
      expectedOpenId: context.providerContext.expectedOpenId,
      featureContext,
      signal,
    });
    if (completed !== "connected") {
      return callbackRedirectResponse(
        completionErrorUrl(target, connectionErrorMessage(completed)),
        query.responseMode,
      );
    }
    return callbackRedirectResponse(
      target === "custom"
        ? customConnectorCallbackUrl("success")
        : feishuBotOpenUrl(installation.appId),
      query.responseMode,
    );
  },
);

const completeCustomFeishuOAuth$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly query: FeishuOAuthCallbackQuery & { readonly state: string };
    },
    signal: AbortSignal,
  ) => {
    const { db, query } = args;
    const preview = await readCustomConnectorOAuthState(
      db,
      { state: query.state },
      signal,
    );
    if (preview.kind !== "usable") {
      return jsonErrorResponse("Invalid or expired connect state");
    }
    const previewContext = validCustomFeishuState(preview.state);
    if (!previewContext) {
      return jsonErrorResponse("Invalid or expired connect state");
    }
    if (
      preview.state.redirectUri === feishuOAuthAppCallbackUrl() &&
      query.responseMode !== "json"
    ) {
      return redirectResponse(appCallbackUrl(query));
    }

    const claimed = await claimCustomConnectorOAuthState(
      db,
      { state: query.state },
      signal,
    );
    signal.throwIfAborted();
    if (claimed.kind !== "usable") {
      return jsonErrorResponse("Invalid or expired connect state");
    }
    const context = validCustomFeishuState(claimed.state);
    if (!context) {
      return jsonErrorResponse("Invalid or expired connect state");
    }
    return await set(
      completeClaimedCustomFeishuOAuth$,
      { db, query, state: claimed.state, context },
      signal,
    );
  },
);

const callback$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(zeroFeishuOauthContract.callback));
  if (!query.state) {
    return jsonErrorResponse("Invalid or expired connect state");
  }

  const legacyState = verifyFeishuOAuthState(query.state);
  if (legacyState?.callbackTarget === "app" && query.responseMode !== "json") {
    return redirectResponse(appCallbackUrl(query));
  }

  const db = set(writeDb$);
  if (legacyState) {
    return await set(
      completeLegacyFeishuOAuth$,
      { db, query, state: legacyState },
      signal,
    );
  }
  return await set(
    completeCustomFeishuOAuth$,
    { db, query: { ...query, state: query.state } },
    signal,
  );
});

export const zeroFeishuOauthRoutes: readonly RouteEntry[] = [
  {
    route: zeroFeishuOauthContract.connect,
    handler: connect$,
  },
  {
    route: zeroFeishuOauthContract.callback,
    handler: callback$,
  },
];
