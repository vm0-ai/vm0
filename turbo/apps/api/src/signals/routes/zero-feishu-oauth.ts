import { command } from "ccstate";
import { and, eq, ne } from "drizzle-orm";
import { zeroFeishuOauthContract } from "@vm0/api-contracts/contracts/zero-feishu-oauth";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$, type Db } from "../external/db";
import {
  exchangeFeishuOAuthCode,
  fetchFeishuUserInfo,
  type FeishuUserInfo,
} from "../external/feishu-client";
import { nowDate } from "../external/time";
import type { RouteEntry } from "../route-entry";
import {
  feishuBotOpenUrl,
  feishuOAuthAppCallbackUrl,
  feishuOAuthCallbackUrl,
  loadFeishuInstallationConfig,
} from "../services/feishu-config";
import {
  createFeishuOAuthAuthorizationState,
  type FeishuOAuthState,
  verifyFeishuOAuthState,
} from "../services/feishu-oauth-state";
import { publishFeishuOrgChanged } from "../services/zero-feishu-realtime.service";
import { notifyFeishuConnect } from "../services/zero-feishu-welcome.service";
import { tapError } from "../utils";

const L = logger("FeishuOAuth");
const FEISHU_AUTHORIZATION_URL =
  "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const REDIRECT_STATUS = 307;

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

function settingsRedirect(params: Readonly<Record<string, string>>): Response {
  return redirectResponse(settingsUrl(params));
}

function settingsUrl(params: Readonly<Record<string, string>>): string {
  const url = new URL("/settings/feishu", env("APP_URL"));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

interface FeishuOAuthCallbackQuery {
  readonly code?: string;
  readonly error?: string;
  readonly error_description?: string;
  readonly responseMode?: "json";
  readonly state?: string;
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

function resolveCallbackState(
  query: FeishuOAuthCallbackQuery,
): FeishuOAuthState | Response {
  const state = query.state ? verifyFeishuOAuthState(query.state) : null;
  if (!state) {
    return jsonErrorResponse("Invalid or expired connect state");
  }
  if (state.callbackTarget === "app" && query.responseMode !== "json") {
    return redirectResponse(appCallbackUrl(query));
  }
  return state;
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

async function exchangeOAuthUserInfo(args: {
  readonly appId: string;
  readonly appSecret: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly installationId: string;
  readonly signal: AbortSignal;
}): Promise<FeishuUserInfo | undefined> {
  return await tapError(
    (async () => {
      const userAccessToken = await exchangeFeishuOAuthCode({
        appId: args.appId,
        appSecret: args.appSecret,
        code: args.code,
        redirectUri: args.redirectUri,
        signal: args.signal,
      });
      return await fetchFeishuUserInfo({
        userAccessToken,
        signal: args.signal,
      });
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
  readonly state: FeishuOAuthState;
  readonly userInfo: FeishuUserInfo;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly connected: false }
  | { readonly connected: true; readonly newConnectionId?: string }
> {
  const [existing] = await args.db
    .select({ vm0UserId: feishuOrgConnections.vm0UserId })
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
  if (existing) {
    await args.db
      .update(feishuOrgConnections)
      .set({
        feishuUserName: args.userInfo.name,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(feishuOrgConnections.installationId, args.state.installationId),
          eq(feishuOrgConnections.feishuOpenId, args.userInfo.openId),
        ),
      );
    args.signal.throwIfAborted();
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
      .returning({ id: feishuOrgConnections.id });
    args.signal.throwIfAborted();
    if (!inserted) {
      return { connected: false };
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
    return { connected: true, newConnectionId: inserted.id };
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
  return { connected: true };
}

const connect$ = command(async ({ get }, signal: AbortSignal) => {
  const query = get(queryOf(zeroFeishuOauthContract.connect));
  const state = query.state ? verifyFeishuOAuthState(query.state) : null;
  if (!state || !query.state) {
    return jsonErrorResponse("Invalid or expired connect state");
  }
  const [installation] = await get(db$)
    .select({
      appId: feishuOrgInstallations.appId,
      setupCompletedAt: feishuOrgInstallations.setupCompletedAt,
    })
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

  const authorizationUrl = new URL(FEISHU_AUTHORIZATION_URL);
  const oauthState = createFeishuOAuthAuthorizationState(
    state,
    query.callbackTarget,
  );
  authorizationUrl.searchParams.set("client_id", installation.appId);
  authorizationUrl.searchParams.set("redirect_uri", feishuOAuthCallbackUrl());
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("state", oauthState);
  return redirectResponse(authorizationUrl.toString());
});

const callback$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(zeroFeishuOauthContract.callback));
  const state = resolveCallbackState(query);
  if (state instanceof Response) {
    return state;
  }
  if (query.error) {
    return callbackRedirectResponse(
      settingsUrl({
        error: query.error_description ?? query.error,
      }),
      query.responseMode,
    );
  }
  if (!query.code) {
    return jsonErrorResponse("Missing authorization code");
  }

  const db = set(writeDb$);
  const config = await loadFeishuInstallationConfig(db, state.installationId);
  signal.throwIfAborted();
  if (!config || config.orgId !== state.orgId) {
    return callbackRedirectResponse(
      settingsUrl({ error: "Feishu bot not found." }),
      query.responseMode,
    );
  }
  const [installation] = await db
    .select({
      tenantKey: feishuOrgInstallations.feishuTenantKey,
      setupCompletedAt: feishuOrgInstallations.setupCompletedAt,
    })
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.id, state.installationId))
    .limit(1);
  signal.throwIfAborted();
  if (!installation?.setupCompletedAt) {
    return callbackRedirectResponse(
      settingsUrl({
        error: "Finish setting up this Feishu bot before connecting.",
      }),
      query.responseMode,
    );
  }

  const userInfo = await exchangeOAuthUserInfo({
    appId: config.appId,
    appSecret: config.appSecret,
    code: query.code,
    redirectUri: feishuOAuthCallbackUrl(),
    installationId: state.installationId,
    signal,
  });
  signal.throwIfAborted();
  if (!userInfo) {
    return callbackRedirectResponse(
      settingsUrl({
        error: "Failed to connect Feishu account. Please try again.",
      }),
      query.responseMode,
    );
  }
  if (
    installation.tenantKey &&
    userInfo.tenantKey &&
    installation.tenantKey !== userInfo.tenantKey
  ) {
    return callbackRedirectResponse(
      settingsUrl({
        error:
          "Use an account from the Feishu tenant connected to this workspace.",
      }),
      query.responseMode,
    );
  }

  const connectionResult = await upsertFeishuConnection({
    db,
    state,
    userInfo,
    signal,
  });
  if (!connectionResult.connected) {
    return callbackRedirectResponse(
      settingsUrl({
        error: "This Feishu account is already connected.",
      }),
      query.responseMode,
    );
  }

  if (!installation.tenantKey && userInfo.tenantKey) {
    await db
      .update(feishuOrgInstallations)
      .set({
        feishuTenantKey: userInfo.tenantKey,
        updatedAt: nowDate(),
      })
      .where(eq(feishuOrgInstallations.id, state.installationId));
  }
  await publishFeishuOrgChanged(db, state.orgId, config.ownerUserId, [
    state.userId,
  ]);
  signal.throwIfAborted();
  if (connectionResult.newConnectionId) {
    const backgroundSignal = new AbortController().signal;
    waitUntil(
      tapError(
        notifyFeishuConnect({
          db,
          installationId: state.installationId,
          connectionId: connectionResult.newConnectionId,
          openId: userInfo.openId,
          signal: backgroundSignal,
        }),
        (error) => {
          L.warn("Failed to send Feishu connect welcome", {
            error,
            installationId: state.installationId,
            openId: userInfo.openId,
          });
        },
      ),
    );
  }
  return callbackRedirectResponse(
    feishuBotOpenUrl(config.appId),
    query.responseMode,
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
