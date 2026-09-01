import { command } from "ccstate";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { appUrlForPublicBrand } from "@okouai/core/public-brand";
import { connectors } from "@okouai/db/schema/connector";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import {
  fetchFeishuUserInfo,
  type FeishuUserInfo,
} from "../external/feishu-client";
import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import {
  claimConnectorOAuthState,
  readCustomConnectorOAuthState,
  type StoredCustomConnectorOAuthState,
} from "../services/connector-oauth-state.service";
import {
  customConnectorOAuthStateMatchesDefinition,
  isCustomConnectorCustomOAuthStateContext,
  decryptCustomConnectorOAuth2Credentials,
  exchangeCustomConnectorOAuth2Code,
  lockCustomConnectorOAuth2CredentialContract,
  parseValidCustomConnectorOAuthState,
  startCustomConnectorOAuth2$,
  storeCustomConnectorOAuth2Connection,
  type CustomConnectorCustomOAuthStateContext,
  type OAuthTokenResult,
} from "../services/custom-connector-oauth2.service";
import {
  ensureFeishuCustomConnector$,
  resolveFeishuConnectorAccountMutation as resolveFeishuAccountMutation,
} from "../services/feishu-custom-connector.service";
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
import {
  addUserCustomConnector,
  lockUserCustomConnectorGrantScope,
} from "../services/user-connectors.service";
import { commitConnectorRuntimeMutation } from "../services/connector-runtime-wakeup.service";
import { publishCustomConnectorUserInvalidationAfterCommit } from "../services/connector-client-invalidation.service";
import {
  getCustomConnectorById,
  type CustomConnectorHttpRow,
  type CustomConnectorRow,
} from "../services/custom-connector.service";
import { publishFeishuOrgChanged } from "../services/feishu-realtime.service";
import { notifyFeishuConnect } from "../services/feishu-welcome.service";
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
  readonly publicBrand: PublicBrand;
  readonly accountMutation: ConnectorAccountMutationIntent;
}

interface FeishuInstallationOAuthRow {
  readonly appId: string;
  readonly tenantKey: string | null;
  readonly setupCompletedAt: Date | null;
  readonly ownerUserId: string | null;
  readonly defaultAgentId: string;
}

type FeishuCustomConnectorOAuthContext = Omit<
  CustomConnectorCustomOAuthStateContext,
  "providerContext"
> & {
  readonly providerContext: Omit<
    NonNullable<CustomConnectorCustomOAuthStateContext["providerContext"]>,
    "completionTarget"
  > & {
    readonly completionTarget: "feishu";
  };
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

function settingsUrl(
  params: Readonly<Record<string, string>>,
  publicBrand: PublicBrand,
): string {
  const url = new URL(
    "/settings/feishu",
    appUrlForPublicBrand(env("APP_URL"), publicBrand),
  );
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function settingsRedirect(
  params: Readonly<Record<string, string>>,
  publicBrand: PublicBrand,
): Response {
  return redirectResponse(settingsUrl(params, publicBrand));
}

function completionErrorUrl(message: string, publicBrand: PublicBrand): string {
  return settingsUrl({ error: message }, publicBrand);
}

function appCallbackUrl(
  query: FeishuOAuthCallbackQuery,
  publicBrand: PublicBrand,
): string {
  const url = new URL(feishuOAuthAppCallbackUrl());
  url.hostname = new URL(
    appUrlForPublicBrand(env("APP_URL"), publicBrand),
  ).hostname;
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

function completionErrorResponse(
  message: string,
  publicBrand: PublicBrand,
  responseMode: "json" | undefined,
): ReturnType<typeof callbackRedirectResponse> {
  return callbackRedirectResponse(
    completionErrorUrl(message, publicBrand),
    responseMode,
  );
}

function validCustomFeishuState(
  storedState: StoredCustomConnectorOAuthState,
): FeishuCustomConnectorOAuthContext | null {
  const context = parseValidCustomConnectorOAuthState(storedState);
  if (
    !context ||
    !isCustomConnectorCustomOAuthStateContext(context) ||
    !context.providerContext ||
    context.providerContext.provider !== "feishu" ||
    context.providerContext.completionTarget !== "feishu"
  ) {
    return null;
  }
  return {
    ...context,
    providerContext: {
      ...context.providerContext,
      completionTarget: "feishu",
    },
  };
}

function isFeishuCustomOAuthConnector(
  connector: CustomConnectorRow | null,
): connector is CustomConnectorHttpRow & {
  readonly oauthSetup: "custom";
  readonly oauthConfig: NonNullable<CustomConnectorHttpRow["oauthConfig"]>;
} {
  return (
    connector?.kind === "http" &&
    connector.oauthSetup === "custom" &&
    connector.oauthConfig?.providerAdapter === "feishu"
  );
}

async function exchangeOAuthTokenAndUserInfo(
  args: {
    readonly connector: CustomConnectorHttpRow;
    readonly clientSecret: string;
    readonly code: string;
    readonly codeVerifier: string | null;
    readonly redirectUri: string;
    readonly installationId: string;
  },
  signal: AbortSignal,
): Promise<
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
      const token = await exchangeCustomConnectorOAuth2Code(
        {
          config: oauthConfig,
          clientSecret: args.clientSecret,
          code: args.code,
          codeVerifier: args.codeVerifier,
          redirectUri: args.redirectUri,
        },
        signal,
      );
      signal.throwIfAborted();
      const userInfo = await fetchFeishuUserInfo(
        {
          userAccessToken: token.accessToken,
        },
        signal,
      );
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

async function upsertFeishuConnection(
  args: {
    readonly db: Db;
    readonly state: FeishuConnectionState;
    readonly userInfo: FeishuUserInfo;
  },
  signal: AbortSignal,
): Promise<
  | { readonly connected: false }
  | {
      readonly connected: true;
      readonly connectionId: string;
      readonly memberConnectorId: string | null;
      readonly shouldNotify: boolean;
    }
> {
  const [existing] = await args.db
    .select({
      id: feishuOrgConnections.id,
      userId: feishuOrgConnections.userId,
      dmWelcomeSent: feishuOrgConnections.dmWelcomeSent,
      connectorId: feishuOrgConnections.connectorId,
    })
    .from(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.installationId, args.state.installationId),
        eq(feishuOrgConnections.feishuOpenId, args.userInfo.openId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (existing && existing.userId !== args.state.userId) {
    return { connected: false };
  }

  let connectionId: string;
  let memberConnectorId: string | null;
  let shouldNotify: boolean;
  if (existing) {
    await args.db
      .update(feishuOrgConnections)
      .set({
        feishuUserName: args.userInfo.name,
        publicBrand: args.state.publicBrand,
        updatedAt: nowDate(),
      })
      .where(eq(feishuOrgConnections.id, existing.id));
    connectionId = existing.id;
    memberConnectorId = existing.connectorId;
    shouldNotify = !existing.dmWelcomeSent;
  } else {
    const [inserted] = await args.db
      .insert(feishuOrgConnections)
      .values({
        installationId: args.state.installationId,
        feishuOpenId: args.userInfo.openId,
        userId: args.state.userId,
        feishuUserName: args.userInfo.name,
        publicBrand: args.state.publicBrand,
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
    signal.throwIfAborted();
    if (!inserted) {
      return { connected: false };
    }
    connectionId = inserted.id;
    memberConnectorId = null;
    shouldNotify = !inserted.dmWelcomeSent;
  }

  await args.db
    .delete(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.installationId, args.state.installationId),
        eq(feishuOrgConnections.userId, args.state.userId),
        ne(feishuOrgConnections.feishuOpenId, args.userInfo.openId),
      ),
    );
  signal.throwIfAborted();
  return { connected: true, connectionId, memberConnectorId, shouldNotify };
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
    isNotNull(feishuOrgInstallations.defaultAgentId),
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
      defaultAgentId: feishuOrgInstallations.defaultAgentId,
    })
    .from(feishuOrgInstallations)
    .where(and(...conditions))
    .limit(1);
  if (!installation?.defaultAgentId) {
    return null;
  }
  return { ...installation, defaultAgentId: installation.defaultAgentId };
}

async function persistFeishuOAuthConnection(
  args: {
    readonly db: Db;
    readonly state: FeishuConnectionState;
    readonly installation: FeishuInstallationOAuthRow;
    readonly connector: CustomConnectorHttpRow;
    readonly token: OAuthTokenResult;
    readonly userInfo: FeishuUserInfo;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<
  | { readonly connected: false }
  | {
      readonly connected: true;
      readonly connectionId: string;
      readonly shouldNotify: boolean;
    }
> {
  return await args.db.transaction(async (tx) => {
    const agentLocked = await lockUserCustomConnectorGrantScope(tx, {
      orgId: args.state.orgId,
      userId: args.state.userId,
      agentId: args.installation.defaultAgentId,
    });
    signal.throwIfAborted();
    if (!agentLocked) {
      throw new Error(
        "Failed to authorize Feishu custom connector: agentNotFound",
      );
    }
    await lockCustomConnectorOAuth2CredentialContract({
      db: tx,
      orgId: args.state.orgId,
      connectorId: args.connector.id,
      storageVersion: args.connector.storageVersion,
    });
    signal.throwIfAborted();
    const connection = await upsertFeishuConnection(
      {
        db: tx,
        state: args.state,
        userInfo: args.userInfo,
      },
      signal,
    );
    if (!connection.connected) {
      return connection;
    }
    const storedConnection = await storeCustomConnectorOAuth2Connection(
      {
        db: tx,
        orgId: args.state.orgId,
        userId: args.state.userId,
        connectorId: args.connector.id,
        storageVersion: args.connector.storageVersion,
        token: args.token,
        featureContext: args.featureContext,
        account: connection.memberConnectorId
          ? {
              intent: "reconnect",
              connectionId: connection.memberConnectorId,
            }
          : args.state.accountMutation,
      },
      signal,
    );
    if (storedConnection.kind !== "stored") {
      throw new Error("Feishu connector account could not be selected");
    }
    const memberConnectorId = storedConnection.connectionId;
    signal.throwIfAborted();
    await tx
      .update(feishuOrgConnections)
      .set({ connectorId: memberConnectorId, updatedAt: nowDate() })
      .where(eq(feishuOrgConnections.id, connection.connectionId));
    await tx
      .update(connectors)
      .set({
        externalId: args.userInfo.openId,
        externalUsername: args.userInfo.name,
        updatedAt: nowDate(),
      })
      .where(eq(connectors.id, memberConnectorId));
    signal.throwIfAborted();
    if (!args.installation.tenantKey && args.userInfo.tenantKey) {
      await tx
        .update(feishuOrgInstallations)
        .set({
          feishuTenantKey: args.userInfo.tenantKey,
          updatedAt: nowDate(),
        })
        .where(eq(feishuOrgInstallations.id, args.state.installationId));
    }
    const grant = await addUserCustomConnector(
      tx,
      {
        orgId: args.state.orgId,
        userId: args.state.userId,
        agentId: args.installation.defaultAgentId,
        customConnectorId: args.connector.id,
      },
      { deferRuntimeWakeupUntilOuterCommit: true },
    );
    if (grant.status !== "added") {
      throw new Error(
        `Failed to authorize Feishu custom connector: ${grant.status}`,
      );
    }
    signal.throwIfAborted();
    return connection;
  });
}

async function finishFeishuOAuthConnection(
  args: {
    readonly db: Db;
    readonly state: FeishuConnectionState;
    readonly installation: FeishuInstallationOAuthRow;
    readonly connector: CustomConnectorHttpRow;
    readonly token: OAuthTokenResult;
    readonly userInfo: FeishuUserInfo;
    readonly expectedOpenId?: string;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<
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
  const connectionPersistence = persistFeishuOAuthConnection(args, signal);
  const connection = await commitConnectorRuntimeMutation(
    connectionPersistence,
    (result) => {
      return result.connected
        ? {
            db: args.db,
            scope: { orgId: args.state.orgId, userId: args.state.userId },
            targets: [{ kind: "custom", customConnectorId: args.connector.id }],
          }
        : undefined;
    },
  );
  if (!connection.connected) {
    signal.throwIfAborted();
    return "account_in_use";
  }

  await publishCustomConnectorUserInvalidationAfterCommit(
    args.state.userId,
    signal,
  );

  await publishFeishuOrgChanged(
    args.db,
    args.state.orgId,
    args.installation.ownerUserId,
    [args.state.userId],
  );
  signal.throwIfAborted();
  if (connection.shouldNotify) {
    const backgroundSignal = new AbortController().signal;
    waitUntil(
      tapError(
        notifyFeishuConnect(
          {
            db: args.db,
            installationId: args.state.installationId,
            connectionId: connection.connectionId,
            openId: args.userInfo.openId,
          },
          backgroundSignal,
        ),
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
  const query = get(queryOf(feishuOauthContract.connect));
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
    return settingsRedirect(
      {
        error: "Finish setting up this Feishu bot before connecting.",
      },
      state.publicBrand,
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
  signal.throwIfAborted();
  if (!connectorId) {
    return jsonErrorResponse("Feishu connector not found");
  }
  const account = await resolveFeishuAccountMutation(db, {
    installationId: state.installationId,
    userId: state.userId,
  });
  signal.throwIfAborted();
  const result = await set(
    startCustomConnectorOAuth2$,
    {
      orgId: state.orgId,
      userId: state.userId,
      connectorId,
      redirectUri: oauthRedirectUri(query.callbackTarget),
      publicBrand: state.publicBrand,
      account,
      feishuContext: {
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
    if (query.error) {
      return completionErrorResponse(
        query.error_description ?? query.error,
        state.publicBrand,
        query.responseMode,
      );
    }
    if (!query.code) {
      return jsonErrorResponse("Missing authorization code");
    }
    const config = await loadFeishuInstallationConfig(db, state.installationId);
    signal.throwIfAborted();
    if (!config || config.orgId !== state.orgId) {
      return completionErrorResponse(
        "Feishu bot not found.",
        state.publicBrand,
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
      return completionErrorResponse(
        "Finish setting up this Feishu bot before connecting.",
        state.publicBrand,
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
      return completionErrorResponse(
        "Feishu connector not found.",
        state.publicBrand,
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
    if (!isFeishuCustomOAuthConnector(connector)) {
      return completionErrorResponse(
        "Feishu connector is unavailable.",
        state.publicBrand,
        query.responseMode,
      );
    }
    const accountMutation = await resolveFeishuAccountMutation(db, state);
    signal.throwIfAborted();
    const exchanged = await exchangeOAuthTokenAndUserInfo(
      {
        connector,
        clientSecret: config.appSecret,
        code: query.code,
        codeVerifier: null,
        redirectUri: oauthRedirectUri(state.oauthRedirectTarget),
        installationId: state.installationId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!exchanged) {
      return completionErrorResponse(
        "Failed to connect Feishu account. Please try again.",
        state.publicBrand,
        query.responseMode,
      );
    }
    const featureContext = await get(
      userFeatureSwitchContext(state.orgId, state.userId),
    );
    signal.throwIfAborted();
    const completed = await finishFeishuOAuthConnection(
      {
        db,
        state: {
          ...state,
          accountMutation,
        },
        installation,
        connector,
        ...exchanged,
        featureContext,
      },
      signal,
    );
    if (completed !== "connected") {
      return completionErrorResponse(
        connectionErrorMessage(completed),
        state.publicBrand,
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
      readonly state: StoredCustomConnectorOAuthState;
      readonly context: FeishuCustomConnectorOAuthContext;
    },
    signal: AbortSignal,
  ) => {
    const { context, db, query, state } = args;
    if (query.error) {
      return completionErrorResponse(
        query.error_description ?? query.error,
        state.publicBrand,
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
      connector?.kind !== "http" ||
      !connector.oauthConfig ||
      connector.oauthConfig.providerAdapter !== "feishu" ||
      !customConnectorOAuthStateMatchesDefinition(context, connector)
    ) {
      return completionErrorResponse(
        "Feishu connector configuration changed. Please try again.",
        state.publicBrand,
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
      return completionErrorResponse(
        "Finish setting up this Feishu bot before connecting.",
        state.publicBrand,
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
      return completionErrorResponse(
        "Could not read Feishu OAuth client credentials.",
        state.publicBrand,
        query.responseMode,
      );
    }
    const exchanged = await exchangeOAuthTokenAndUserInfo(
      {
        connector,
        clientSecret: credentials.clientSecret,
        code: query.code,
        codeVerifier: state.codeVerifier,
        redirectUri: state.redirectUri,
        installationId: installation.installationId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!exchanged) {
      return completionErrorResponse(
        "Failed to connect Feishu account. Please try again.",
        state.publicBrand,
        query.responseMode,
      );
    }
    const connectionState: FeishuConnectionState = {
      installationId: installation.installationId,
      orgId: args.state.orgId,
      userId: args.state.userId,
      publicBrand: args.state.publicBrand,
      accountMutation: args.state.accountMutation,
    };
    const completed = await finishFeishuOAuthConnection(
      {
        db,
        state: connectionState,
        installation,
        connector,
        ...exchanged,
        expectedOpenId: context.providerContext.expectedOpenId,
        featureContext,
      },
      signal,
    );
    if (completed !== "connected") {
      return completionErrorResponse(
        connectionErrorMessage(completed),
        state.publicBrand,
        query.responseMode,
      );
    }
    return callbackRedirectResponse(
      feishuBotOpenUrl(installation.appId),
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
      return redirectResponse(appCallbackUrl(query, preview.state.publicBrand));
    }

    const claimed = await claimConnectorOAuthState(
      db,
      { state: query.state, target: { kind: "custom" } },
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
  const query = get(queryOf(feishuOauthContract.callback));
  if (!query.state) {
    return jsonErrorResponse("Invalid or expired connect state");
  }

  const legacyState = verifyFeishuOAuthState(query.state);
  if (legacyState?.callbackTarget === "app" && query.responseMode !== "json") {
    return redirectResponse(appCallbackUrl(query, legacyState.publicBrand));
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

export const feishuOauthRoutes: readonly RouteEntry[] = [
  {
    route: feishuOauthContract.connect,
    handler: connect$,
  },
  {
    route: feishuOauthContract.callback,
    handler: callback$,
  },
];
