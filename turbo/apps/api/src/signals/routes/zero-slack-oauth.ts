import { command, computed } from "ccstate";
import { zeroSlackOauthContract } from "@vm0/api-contracts/contracts/zero-slack-oauth";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { eq } from "drizzle-orm";

import { queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import {
  exchangeSlackOAuthCode,
  exchangeSlackOAuthCodeForUser,
} from "../external/slack-oauth-client";
import { logger } from "../../lib/log";
import { env, optionalEnv } from "../../lib/env";
import { safeAsync, safeJsonParse } from "../utils";
import { encryptSecretValue } from "../services/crypto.utils";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import {
  connectSlackWorkspace$,
  notifySlackConnect$,
  publishSlackAdminSignal$,
} from "../services/zero-slack-connect.service";
import { SLACK_BOT_SCOPES } from "../services/zero-slack-data.service";
import type { RouteEntry } from "../route";

const L = logger("SlackOAuth");
const SLACK_OAUTH_URL = "https://slack.com/oauth/v2/authorize";
const REDIRECT_STATUS = 307;
const MAX_PROMPT_STATE_LENGTH = 500;

type SlackInstallation = typeof slackOrgInstallations.$inferSelect;

interface OAuthState {
  readonly orgId: string | null;
  readonly vm0UserId: string | null;
  readonly flow: "install" | "connect";
  readonly reinstall: boolean;
  readonly prompt: string | null;
}

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

function noStoreRedirect(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url, "Cache-Control": "no-store" },
  });
}

function jsonErrorResponse(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function appUrl(path: string): string {
  return `${env("VM0_WEB_URL")}${path}`;
}

function failedRedirect(message: string): Response {
  return redirectResponse(
    appUrl(`/slack/failed?error=${encodeURIComponent(message)}`),
  );
}

function settingsErrorRedirect(message: string): Response {
  return redirectResponse(
    appUrl(`/settings/slack?error=${encodeURIComponent(message)}`),
  );
}

function truncatePrompt(prompt: string): string {
  return [...prompt].slice(0, MAX_PROMPT_STATE_LENGTH).join("");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalBoolean(value: unknown): boolean {
  return value === true;
}

function parseOAuthState(state: string | undefined): OAuthState {
  if (!state) {
    return {
      orgId: null,
      vm0UserId: null,
      flow: "install",
      reinstall: false,
      prompt: null,
    };
  }

  const parsed = safeJsonParse(state);
  if (typeof parsed !== "object" || parsed === null) {
    return {
      orgId: null,
      vm0UserId: null,
      flow: "install",
      reinstall: false,
      prompt: null,
    };
  }

  const record = parsed as Record<string, unknown>;
  return {
    orgId: optionalString(record.orgId),
    vm0UserId: optionalString(record.vm0UserId),
    flow: record.flow === "connect" ? "connect" : "install",
    reinstall: optionalBoolean(record.reinstall),
    prompt: optionalString(record.prompt),
  };
}

function callbackRedirectUri(): string {
  return `${env("VM0_API_URL")}/api/zero/slack/oauth/callback`;
}

function slackCredentials(): {
  readonly clientId: string;
  readonly clientSecret: string;
} | null {
  const clientId = env("SLACK_CLIENT_ID");
  const clientSecret = optionalEnv("SLACK_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

const installOauth$ = computed((get) => {
  const clientId = env("SLACK_CLIENT_ID");
  if (!clientId) {
    return jsonErrorResponse("Slack integration is not configured", 503);
  }

  const query = get(queryOf(zeroSlackOauthContract.install));
  const stateObj: {
    orgId?: string;
    vm0UserId?: string;
    reinstall?: boolean;
    prompt?: string;
  } = {};
  if (query.orgId) {
    stateObj.orgId = query.orgId;
  }
  if (query.vm0UserId) {
    stateObj.vm0UserId = query.vm0UserId;
  }
  if (query.reinstall === "1") {
    stateObj.reinstall = true;
  }
  if (query.prompt) {
    stateObj.prompt = truncatePrompt(query.prompt);
  }
  const state =
    Object.keys(stateObj).length > 0 ? JSON.stringify(stateObj) : "";

  const authUrl = new URL(SLACK_OAUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  authUrl.searchParams.set("redirect_uri", callbackRedirectUri());
  if (state) {
    authUrl.searchParams.set("state", state);
  }

  return noStoreRedirect(authUrl.toString());
});

const connectOauth$ = command(async ({ get }, signal: AbortSignal) => {
  const clientId = env("SLACK_CLIENT_ID");
  if (!clientId) {
    return jsonErrorResponse("Slack integration is not configured", 503);
  }

  const query = get(queryOf(zeroSlackOauthContract.connect));
  if (!query.orgId || !query.vm0UserId) {
    return jsonErrorResponse("Missing orgId or vm0UserId", 400);
  }

  const db = get(db$);
  const [installation] = await db
    .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, query.orgId))
    .limit(1);
  signal.throwIfAborted();

  if (!installation) {
    return jsonErrorResponse(
      "No Slack workspace installed for this organization",
      404,
    );
  }

  const stateObj: {
    orgId: string;
    vm0UserId: string;
    flow: "connect";
    prompt?: string;
  } = {
    orgId: query.orgId,
    vm0UserId: query.vm0UserId,
    flow: "connect",
  };
  if (query.prompt) {
    stateObj.prompt = truncatePrompt(query.prompt);
  }

  const authUrl = new URL(SLACK_OAUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("user_scope", "identity.basic");
  authUrl.searchParams.set("redirect_uri", callbackRedirectUri());
  authUrl.searchParams.set("state", JSON.stringify(stateObj));
  authUrl.searchParams.set("team", installation.slackWorkspaceId);

  return noStoreRedirect(authUrl.toString());
});

type CommandSetter = <T, TArgs extends unknown[]>(
  command: import("ccstate").Command<T, TArgs>,
  ...args: TArgs
) => T;

function notifyAfterConnect(args: {
  readonly set: CommandSetter;
  readonly installation: SlackInstallation;
  readonly slackUserId: string;
  readonly orgId: string;
  readonly pendingPrompt: string | null;
  readonly signal: AbortSignal;
}): void {
  waitUntil(
    Promise.resolve(
      args.set(
        notifySlackConnect$,
        {
          installation: args.installation,
          slackUserId: args.slackUserId,
          orgId: args.orgId,
          ...(args.pendingPrompt ? { pendingPrompt: args.pendingPrompt } : {}),
        },
        args.signal,
      ),
    ).catch((error: unknown) => {
      L.warn("Failed to notify connect success", { error });
    }),
  );
}

async function handlePlatformInstall(args: {
  readonly set: <T, TArgs extends unknown[]>(
    command: import("ccstate").Command<T, TArgs>,
    ...args: TArgs
  ) => T;
  readonly installation: SlackInstallation;
  readonly authedUserId: string;
  readonly teamName: string;
  readonly state: OAuthState;
  readonly isReinstall: boolean;
  readonly signal: AbortSignal;
}): Promise<Response> {
  if (!args.state.orgId || !args.state.vm0UserId) {
    return redirectResponse(
      appUrl(
        `/settings/slack?w=${encodeURIComponent(args.installation.slackWorkspaceId)}&u=${encodeURIComponent(args.authedUserId)}`,
      ),
    );
  }

  const member = await args.set(
    getMemberRoleAndUpdateCache$,
    args.state.orgId,
    args.state.vm0UserId,
    args.signal,
  );
  args.signal.throwIfAborted();

  if (!member) {
    throw new Error("You are not a member of this organization");
  }

  if (member.role !== "admin") {
    return failedRedirect(
      "Only org admins can install Slack for an organization.",
    );
  }

  const writeDb = args.set(writeDb$);
  await writeDb
    .insert(slackOrgConnections)
    .values({
      slackUserId: args.authedUserId,
      slackWorkspaceId: args.installation.slackWorkspaceId,
      vm0UserId: args.state.vm0UserId,
    })
    .onConflictDoNothing();
  args.signal.throwIfAborted();

  notifyAfterConnect({
    set: args.set,
    installation: args.installation,
    slackUserId: args.authedUserId,
    orgId: args.state.orgId,
    pendingPrompt: args.state.prompt,
    signal: args.signal,
  });

  if (args.isReinstall && args.state.reinstall) {
    return redirectResponse(appUrl("/?tab=works&updated=1"));
  }

  return redirectResponse(
    appUrl(
      `/settings/slack?status=connected&workspace=${encodeURIComponent(args.teamName)}`,
    ),
  );
}

async function handleInstallCallback(args: {
  readonly set: <T, TArgs extends unknown[]>(
    command: import("ccstate").Command<T, TArgs>,
    ...args: TArgs
  ) => T;
  readonly code: string;
  readonly state: OAuthState;
  readonly credentials: {
    readonly clientId: string;
    readonly clientSecret: string;
  };
  readonly signal: AbortSignal;
}): Promise<Response> {
  const exchange = await safeAsync(() => {
    return exchangeSlackOAuthCode(
      args.credentials.clientId,
      args.credentials.clientSecret,
      args.code,
      callbackRedirectUri(),
    );
  });
  args.signal.throwIfAborted();

  if ("error" in exchange) {
    L.error("Slack OAuth exchange failed", { error: exchange.error });
    return failedRedirect(
      "Failed to complete Slack installation. Please try again.",
    );
  }

  const oauthResult = exchange.ok;
  const writeDb = args.set(writeDb$);
  const encryptedBotToken = encryptSecretValue(oauthResult.accessToken);
  const botScopes = oauthResult.scope
    ? JSON.stringify(oauthResult.scope.split(",").filter(Boolean))
    : null;

  const [existing] = await writeDb
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId))
    .limit(1);
  args.signal.throwIfAborted();

  const isReinstall = existing !== undefined;
  if (existing) {
    if (
      existing.orgId &&
      args.state.orgId &&
      existing.orgId !== args.state.orgId
    ) {
      L.warn("Install rejected: workspace already bound to another org", {
        workspaceId: oauthResult.teamId,
        existingOrgId: existing.orgId,
        requestedOrgId: args.state.orgId,
      });
      return settingsErrorRedirect(
        "This Slack workspace is already installed by another organization. Please contact the workspace admin to uninstall first.",
      );
    }

    await writeDb
      .update(slackOrgInstallations)
      .set({
        encryptedBotToken,
        botUserId: oauthResult.botUserId,
        slackWorkspaceName: oauthResult.teamName,
        botScopes,
        updatedAt: nowDate(),
      })
      .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId));
    args.signal.throwIfAborted();
  } else {
    const isPlatformFlow = Boolean(args.state.orgId && args.state.vm0UserId);
    await writeDb.insert(slackOrgInstallations).values({
      slackWorkspaceId: oauthResult.teamId,
      slackWorkspaceName: oauthResult.teamName,
      orgId: isPlatformFlow ? args.state.orgId : null,
      encryptedBotToken,
      botUserId: oauthResult.botUserId,
      installedByUserId: isPlatformFlow ? args.state.vm0UserId : null,
      botScopes,
    });
    args.signal.throwIfAborted();
  }

  const [installation] = await writeDb
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId))
    .limit(1);
  args.signal.throwIfAborted();

  if (!installation) {
    throw new Error("Slack installation upsert did not return a row");
  }

  if (args.state.orgId && args.state.vm0UserId) {
    return await handlePlatformInstall({
      set: args.set,
      installation,
      authedUserId: oauthResult.authedUserId,
      teamName: oauthResult.teamName,
      state: args.state,
      isReinstall,
      signal: args.signal,
    });
  }

  return redirectResponse(
    appUrl(
      `/settings/slack?w=${encodeURIComponent(oauthResult.teamId)}&u=${encodeURIComponent(oauthResult.authedUserId)}`,
    ),
  );
}

async function handleConnectCallback(args: {
  readonly set: <T, TArgs extends unknown[]>(
    command: import("ccstate").Command<T, TArgs>,
    ...args: TArgs
  ) => T;
  readonly code: string;
  readonly state: OAuthState;
  readonly credentials: {
    readonly clientId: string;
    readonly clientSecret: string;
  };
  readonly signal: AbortSignal;
}): Promise<Response> {
  if (!args.state.orgId || !args.state.vm0UserId) {
    return settingsErrorRedirect("Invalid connect state.");
  }

  const exchange = await safeAsync(() => {
    return exchangeSlackOAuthCodeForUser(
      args.credentials.clientId,
      args.credentials.clientSecret,
      args.code,
      callbackRedirectUri(),
    );
  });
  args.signal.throwIfAborted();

  if ("error" in exchange) {
    L.error("Slack OAuth exchange failed (connect flow)", {
      error: exchange.error,
    });
    return settingsErrorRedirect(
      "Failed to connect Slack account. Please try again.",
    );
  }

  const writeDb = args.set(writeDb$);
  const [installation] = await writeDb
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, args.state.orgId))
    .limit(1);
  args.signal.throwIfAborted();

  if (!installation) {
    return settingsErrorRedirect(
      "No Slack workspace installed for this organization.",
    );
  }

  if (exchange.ok.teamId !== installation.slackWorkspaceId) {
    return settingsErrorRedirect(
      "You authenticated with a different Slack workspace. Please use the workspace connected to your organization.",
    );
  }

  const member = await args.set(
    getMemberRoleAndUpdateCache$,
    args.state.orgId,
    args.state.vm0UserId,
    args.signal,
  );
  args.signal.throwIfAborted();

  if (!member) {
    throw new Error("You are not a member of this organization");
  }

  const connectionResult = await args.set(
    connectSlackWorkspace$,
    {
      userId: args.state.vm0UserId,
      orgId: args.state.orgId,
      orgRole: member.role,
      workspaceId: installation.slackWorkspaceId,
      slackUserId: exchange.ok.authedUserId,
    },
    args.signal,
  );
  args.signal.throwIfAborted();

  if (connectionResult.kind !== "ok") {
    return settingsErrorRedirect(connectionResult.message);
  }

  await args.set(
    publishSlackAdminSignal$,
    { orgId: args.state.orgId, topic: "slack:changed" },
    args.signal,
  );
  args.signal.throwIfAborted();

  notifyAfterConnect({
    set: args.set,
    installation,
    slackUserId: exchange.ok.authedUserId,
    orgId: args.state.orgId,
    pendingPrompt: args.state.prompt,
    signal: args.signal,
  });

  return redirectResponse(
    appUrl(
      `/settings/slack?status=connected&workspace=${encodeURIComponent(installation.slackWorkspaceName ?? "")}`,
    ),
  );
}

const callbackOauth$ = command(async ({ get, set }, signal: AbortSignal) => {
  const credentials = slackCredentials();
  if (!credentials) {
    return jsonErrorResponse("Slack integration is not configured", 503);
  }

  const query = get(queryOf(zeroSlackOauthContract.callback));

  if (query.error) {
    return failedRedirect(query.error);
  }

  if (!query.code) {
    return jsonErrorResponse("Missing authorization code", 400);
  }

  const state = parseOAuthState(query.state);
  if (state.flow === "connect") {
    return await handleConnectCallback({
      set,
      code: query.code,
      state,
      credentials,
      signal,
    });
  }

  return await handleInstallCallback({
    set,
    code: query.code,
    state,
    credentials,
    signal,
  });
});

export const zeroSlackOauthRoutes: readonly RouteEntry[] = [
  {
    route: zeroSlackOauthContract.install,
    handler: installOauth$,
  },
  {
    route: zeroSlackOauthContract.connect,
    handler: connectOauth$,
  },
  {
    route: zeroSlackOauthContract.callback,
    handler: callbackOauth$,
  },
];
