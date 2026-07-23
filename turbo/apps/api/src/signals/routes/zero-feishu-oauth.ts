import { command } from "ccstate";
import { and, eq, ne } from "drizzle-orm";
import { zeroFeishuOauthContract } from "@vm0/api-contracts/contracts/zero-feishu-oauth";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { requiredAuthContext$ } from "../auth/auth-context";
import { request$ } from "../context/hono";
import { queryOf } from "../context/request";
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
  feishuOAuthCallbackUrl,
  loadFeishuInstallationConfig,
} from "../services/feishu-config";
import {
  type FeishuOAuthState,
  verifyFeishuOAuthState,
} from "../services/feishu-oauth-state";
import { publishFeishuOrgChanged } from "../services/zero-feishu-realtime.service";
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
  const url = new URL("/settings/feishu", env("APP_URL"));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return redirectResponse(url.toString());
}

function signInRedirect(requestUrl: string): Response {
  const url = new URL("/sign-in", env("APP_URL"));
  url.searchParams.set("redirect_url", requestUrl);
  return redirectResponse(url.toString());
}

type AuthenticatedStateResult =
  | { readonly kind: "ok"; readonly state: FeishuOAuthState }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "invalid" };

const resolveAuthenticatedState$ = command(
  async (
    { set },
    encodedState: string | undefined,
    signal: AbortSignal,
  ): Promise<AuthenticatedStateResult> => {
    const state = encodedState ? verifyFeishuOAuthState(encodedState) : null;
    if (!state) {
      return { kind: "invalid" };
    }
    const auth = await set(
      requiredAuthContext$,
      { requireOrganization: true },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in auth) {
      return auth.status === 401
        ? { kind: "unauthenticated" }
        : { kind: "invalid" };
    }
    if (auth.userId !== state.userId || auth.orgId !== state.orgId) {
      return { kind: "invalid" };
    }
    return { kind: "ok", state };
  },
);

async function exchangeOAuthUserInfo(args: {
  readonly appId: string;
  readonly appSecret: string;
  readonly code: string;
  readonly installationId: string;
  readonly signal: AbortSignal;
}): Promise<FeishuUserInfo | undefined> {
  return await tapError(
    (async () => {
      const userAccessToken = await exchangeFeishuOAuthCode({
        appId: args.appId,
        appSecret: args.appSecret,
        code: args.code,
        redirectUri: feishuOAuthCallbackUrl(),
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
}): Promise<boolean> {
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
    return false;
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
      return false;
    }
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
  return true;
}

const connect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(zeroFeishuOauthContract.connect));
  const resolved = await set(resolveAuthenticatedState$, query.state, signal);
  if (resolved.kind === "unauthenticated") {
    return signInRedirect(get(request$).url);
  }
  if (resolved.kind === "invalid" || !query.state) {
    return jsonErrorResponse("Invalid or expired connect state");
  }
  const { state } = resolved;
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
  authorizationUrl.searchParams.set("client_id", installation.appId);
  authorizationUrl.searchParams.set("redirect_uri", feishuOAuthCallbackUrl());
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("state", query.state);
  return redirectResponse(authorizationUrl.toString());
});

const callback$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(zeroFeishuOauthContract.callback));
  const resolved = await set(resolveAuthenticatedState$, query.state, signal);
  if (resolved.kind === "unauthenticated") {
    return signInRedirect(get(request$).url);
  }
  if (resolved.kind === "invalid") {
    return jsonErrorResponse("Invalid or expired connect state");
  }
  const { state } = resolved;
  if (query.error) {
    return settingsRedirect({
      error: query.error_description ?? query.error,
    });
  }
  if (!query.code) {
    return jsonErrorResponse("Missing authorization code");
  }

  const db = set(writeDb$);
  const config = await loadFeishuInstallationConfig(db, state.installationId);
  signal.throwIfAborted();
  if (!config || config.orgId !== state.orgId) {
    return settingsRedirect({ error: "Feishu bot not found." });
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
    return settingsRedirect({
      error: "Finish setting up this Feishu bot before connecting.",
    });
  }

  const userInfo = await exchangeOAuthUserInfo({
    appId: config.appId,
    appSecret: config.appSecret,
    code: query.code,
    installationId: state.installationId,
    signal,
  });
  signal.throwIfAborted();
  if (!userInfo) {
    return settingsRedirect({
      error: "Failed to connect Feishu account. Please try again.",
    });
  }
  if (
    installation.tenantKey &&
    userInfo.tenantKey &&
    installation.tenantKey !== userInfo.tenantKey
  ) {
    return settingsRedirect({
      error:
        "Use an account from the Feishu tenant connected to this workspace.",
    });
  }

  const connected = await upsertFeishuConnection({
    db,
    state,
    userInfo,
    signal,
  });
  if (!connected) {
    return settingsRedirect({
      error: "This Feishu account is already connected.",
    });
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
  return redirectResponse(feishuBotOpenUrl(config.appId));
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
