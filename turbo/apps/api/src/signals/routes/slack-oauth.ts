import { command, computed } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { zeroSlackOauthContract } from "@okouai/api-contracts/contracts/zero-slack-oauth";
import { appUrlForPublicBrand } from "@okouai/core/public-brand";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { eq } from "drizzle-orm";

import { publicBrand$, request$ } from "../context/hono";
import { queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  exchangeSlackOAuthCode,
  exchangeSlackOAuthCodeForUser,
} from "../external/slack-oauth-client";
import { logger } from "../../lib/log";
import { env, optionalEnv } from "../../lib/env";
import { safeJsonParse, tapError } from "../utils";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import {
  connectSlackWorkspace$,
  notifySlackConnect$,
  publishSlackAdminSignal$,
} from "../services/zero-slack-connect.service";
import { SLACK_BOT_SCOPES } from "../services/zero-slack-data.service";
import type { RouteEntry } from "../route-entry";
import {
  getOAuthCanonicalRedirectUrl,
  getOAuthWebOrigin,
} from "../../lib/oauth-origin";
import { resolveIntegrationUserId } from "../../lib/integration-user-id-compat";

const L = logger("SlackOAuth");
const SLACK_OAUTH_URL = "https://slack.com/oauth/v2/authorize";
const REDIRECT_STATUS = 307;
const MAX_PROMPT_STATE_LENGTH = 500;

type SlackInstallation = typeof slackOrgInstallations.$inferSelect;

interface OAuthState {
  readonly orgId: string | null;
  readonly userId: string | null;
  readonly flow: "install" | "connect";
  readonly reinstall: boolean;
  readonly prompt: string | null;
  readonly publicBrand: PublicBrand;
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

function appUrl(path: string, publicBrand: PublicBrand): string {
  return `${appUrlForPublicBrand(env("APP_URL"), publicBrand)}${path}`;
}

function failedRedirect(message: string, publicBrand: PublicBrand): Response {
  return redirectResponse(
    appUrl(`/slack/failed?error=${encodeURIComponent(message)}`, publicBrand),
  );
}

function settingsErrorRedirect(
  message: string,
  publicBrand: PublicBrand,
): Response {
  return redirectResponse(
    appUrl(`/settings/slack?error=${encodeURIComponent(message)}`, publicBrand),
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

function parseOAuthState(state: string | undefined): OAuthState | null {
  if (!state) {
    return {
      orgId: null,
      userId: null,
      flow: "install",
      reinstall: false,
      prompt: null,
      publicBrand: "vm0",
    };
  }

  const parsed = safeJsonParse(state);
  if (typeof parsed !== "object" || parsed === null) {
    return {
      orgId: null,
      userId: null,
      flow: "install",
      reinstall: false,
      prompt: null,
      publicBrand: "vm0",
    };
  }

  const record = parsed as Record<string, unknown>;
  const userId = resolveIntegrationUserId(
    optionalString(record.userId),
    // Old web/app OAuth state fallback (observed maximum: ~2 days).
    // Remove in #27602 after legacy producers and callbacks have drained.
    optionalString(record.vm0UserId),
  );
  if (!userId.ok) {
    return null;
  }
  return {
    orgId: optionalString(record.orgId),
    userId: userId.userId,
    flow: record.flow === "connect" ? "connect" : "install",
    reinstall: optionalBoolean(record.reinstall),
    prompt: optionalString(record.prompt),
    publicBrand: record.publicBrand === "okou" ? "okou" : "vm0",
  };
}

function callbackRedirectUri(origin: string): string {
  return `${origin}/api/zero/slack/oauth/callback`;
}

function slackCredentials(): {
  readonly clientId: string;
  readonly clientSecret: string;
} | null {
  const clientId = env("SLACK_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("SLACK_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

const installOauth$ = computed((get) => {
  const request = get(request$).raw;
  const publicBrand = get(publicBrand$);
  const canonicalRedirectUrl = getOAuthCanonicalRedirectUrl(request);
  if (canonicalRedirectUrl) {
    return noStoreRedirect(canonicalRedirectUrl);
  }
  const origin = getOAuthWebOrigin(request);
  const clientId = env("SLACK_OAUTH_CLIENT_ID");
  if (!clientId) {
    return jsonErrorResponse("Slack integration is not configured", 503);
  }

  const query = get(queryOf(zeroSlackOauthContract.install));
  const userId = resolveIntegrationUserId(query.userId, query.vm0UserId);
  if (!userId.ok) {
    return failedRedirect("Invalid OAuth identity.", publicBrand);
  }
  const stateObj: {
    orgId?: string;
    userId?: string;
    reinstall?: boolean;
    prompt?: string;
    publicBrand: PublicBrand;
  } = { publicBrand };
  if (query.orgId) {
    stateObj.orgId = query.orgId;
  }
  if (userId.userId) {
    stateObj.userId = userId.userId;
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
  authUrl.searchParams.set("redirect_uri", callbackRedirectUri(origin));
  if (state) {
    authUrl.searchParams.set("state", state);
  }

  return noStoreRedirect(authUrl.toString());
});

const connectOauth$ = command(async ({ get }, signal: AbortSignal) => {
  const request = get(request$).raw;
  const publicBrand = get(publicBrand$);
  const canonicalRedirectUrl = getOAuthCanonicalRedirectUrl(request);
  if (canonicalRedirectUrl) {
    return noStoreRedirect(canonicalRedirectUrl);
  }
  const origin = getOAuthWebOrigin(request);
  const clientId = env("SLACK_OAUTH_CLIENT_ID");
  if (!clientId) {
    return jsonErrorResponse("Slack integration is not configured", 503);
  }

  const query = get(queryOf(zeroSlackOauthContract.connect));
  const userId = resolveIntegrationUserId(query.userId, query.vm0UserId);
  if (!userId.ok) {
    return jsonErrorResponse("Conflicting userId values", 400);
  }
  if (!query.orgId || !userId.userId) {
    return jsonErrorResponse("Missing orgId or userId", 400);
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
    userId: string;
    flow: "connect";
    prompt?: string;
    publicBrand: PublicBrand;
  } = {
    orgId: query.orgId,
    userId: userId.userId,
    flow: "connect",
    publicBrand,
  };
  if (query.prompt) {
    stateObj.prompt = truncatePrompt(query.prompt);
  }

  const authUrl = new URL(SLACK_OAUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("user_scope", "identity.basic");
  authUrl.searchParams.set("redirect_uri", callbackRedirectUri(origin));
  authUrl.searchParams.set("state", JSON.stringify(stateObj));
  authUrl.searchParams.set("team", installation.slackWorkspaceId);

  return noStoreRedirect(authUrl.toString());
});

const notifyAfterConnect$ = command(
  (
    { set },
    args: {
      readonly installation: SlackInstallation;
      readonly slackUserId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly pendingPrompt: string | null;
    },
    signal: AbortSignal,
  ): void => {
    waitUntil(
      tapError(
        Promise.resolve(
          set(
            notifySlackConnect$,
            {
              installation: args.installation,
              slackUserId: args.slackUserId,
              orgId: args.orgId,
              userId: args.userId,
              ...(args.pendingPrompt
                ? { pendingPrompt: args.pendingPrompt }
                : {}),
            },
            signal,
          ),
        ),
        (error) => {
          L.warn("Failed to notify connect success", { error });
        },
      ),
    );
  },
);

const handlePlatformInstall$ = command(
  async (
    { set },
    args: {
      readonly installation: SlackInstallation;
      readonly authedUserId: string;
      readonly teamName: string;
      readonly state: OAuthState;
      readonly isReinstall: boolean;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    if (!args.state.orgId || !args.state.userId) {
      return redirectResponse(
        appUrl(
          `/settings/slack?w=${encodeURIComponent(args.installation.slackWorkspaceId)}&u=${encodeURIComponent(args.authedUserId)}`,
          args.state.publicBrand,
        ),
      );
    }

    const member = await set(
      getMemberRoleAndUpdateCache$,
      args.state.orgId,
      args.state.userId,
      signal,
    );
    signal.throwIfAborted();

    if (!member) {
      throw new Error("You are not a member of this organization");
    }

    if (member.role !== "admin") {
      return failedRedirect(
        "Only org admins can install Slack for an organization.",
        args.state.publicBrand,
      );
    }

    const writeDb = set(writeDb$);
    await writeDb
      .insert(slackOrgConnections)
      .values({
        slackUserId: args.authedUserId,
        slackWorkspaceId: args.installation.slackWorkspaceId,
        userId: args.state.userId,
        legacyUserId: args.state.userId,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();

    set(
      notifyAfterConnect$,
      {
        installation: args.installation,
        slackUserId: args.authedUserId,
        orgId: args.state.orgId,
        userId: args.state.userId,
        pendingPrompt: args.state.prompt,
      },
      signal,
    );

    if (args.isReinstall && args.state.reinstall) {
      return redirectResponse(
        appUrl("/?tab=works&updated=1", args.state.publicBrand),
      );
    }

    return redirectResponse(
      appUrl(
        `/settings/slack?status=connected&workspace=${encodeURIComponent(args.teamName)}`,
        args.state.publicBrand,
      ),
    );
  },
);

const handleInstallCallback$ = command(
  async (
    { set },
    args: {
      readonly code: string;
      readonly state: OAuthState;
      readonly credentials: {
        readonly clientId: string;
        readonly clientSecret: string;
      };
      readonly callbackOrigin: string;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    const oauthResult = await tapError(
      exchangeSlackOAuthCode(
        args.credentials.clientId,
        args.credentials.clientSecret,
        args.code,
        callbackRedirectUri(args.callbackOrigin),
      ),
      (error) => {
        L.error("Slack OAuth exchange failed", { error });
      },
    );
    signal.throwIfAborted();

    if (!oauthResult) {
      return failedRedirect(
        "Failed to complete Slack installation. Please try again.",
        args.state.publicBrand,
      );
    }

    const writeDb = set(writeDb$);
    const featureSwitchContext =
      args.state.orgId && args.state.userId
        ? await loadUserFeatureSwitchContext(
            writeDb,
            args.state.orgId,
            args.state.userId,
          )
        : {};
    const encryptedBotToken = await encryptPersistentSecretValue(
      oauthResult.accessToken,
      featureSwitchContext,
    );
    signal.throwIfAborted();
    const botScopes = oauthResult.scope
      ? JSON.stringify(oauthResult.scope.split(",").filter(Boolean))
      : null;

    const [existing] = await writeDb
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId))
      .limit(1);
    signal.throwIfAborted();

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
          args.state.publicBrand,
        );
      }

      await writeDb
        .update(slackOrgInstallations)
        .set({
          encryptedBotToken,
          botUserId: oauthResult.botUserId,
          slackWorkspaceName: oauthResult.teamName,
          botScopes,
          publicBrand: args.state.publicBrand,
          updatedAt: nowDate(),
        })
        .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId));
      signal.throwIfAborted();
    } else {
      const isPlatformFlow = Boolean(args.state.orgId && args.state.userId);
      await writeDb.insert(slackOrgInstallations).values({
        slackWorkspaceId: oauthResult.teamId,
        slackWorkspaceName: oauthResult.teamName,
        orgId: isPlatformFlow ? args.state.orgId : null,
        encryptedBotToken,
        botUserId: oauthResult.botUserId,
        installedByUserId: isPlatformFlow ? args.state.userId : null,
        botScopes,
        publicBrand: args.state.publicBrand,
      });
      signal.throwIfAborted();
    }

    const [installation] = await writeDb
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation) {
      throw new Error("Slack installation upsert did not return a row");
    }

    if (args.state.orgId && args.state.userId) {
      return await set(
        handlePlatformInstall$,
        {
          installation,
          authedUserId: oauthResult.authedUserId,
          teamName: oauthResult.teamName,
          state: args.state,
          isReinstall,
        },
        signal,
      );
    }

    return redirectResponse(
      appUrl(
        `/settings/slack?w=${encodeURIComponent(oauthResult.teamId)}&u=${encodeURIComponent(oauthResult.authedUserId)}`,
        args.state.publicBrand,
      ),
    );
  },
);

const handleConnectCallback$ = command(
  async (
    { set },
    args: {
      readonly code: string;
      readonly state: OAuthState;
      readonly credentials: {
        readonly clientId: string;
        readonly clientSecret: string;
      };
      readonly callbackOrigin: string;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    if (!args.state.orgId || !args.state.userId) {
      return settingsErrorRedirect(
        "Invalid connect state.",
        args.state.publicBrand,
      );
    }

    const oauthResult = await tapError(
      exchangeSlackOAuthCodeForUser(
        args.credentials.clientId,
        args.credentials.clientSecret,
        args.code,
        callbackRedirectUri(args.callbackOrigin),
      ),
      (error) => {
        L.error("Slack OAuth exchange failed (connect flow)", { error });
      },
    );
    signal.throwIfAborted();

    if (!oauthResult) {
      return settingsErrorRedirect(
        "Failed to connect Slack account. Please try again.",
        args.state.publicBrand,
      );
    }

    const writeDb = set(writeDb$);
    const [installation] = await writeDb
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.state.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation) {
      return settingsErrorRedirect(
        "No Slack workspace installed for this organization.",
        args.state.publicBrand,
      );
    }

    if (oauthResult.teamId !== installation.slackWorkspaceId) {
      return settingsErrorRedirect(
        "You authenticated with a different Slack workspace. Please use the workspace connected to your organization.",
        args.state.publicBrand,
      );
    }

    const member = await set(
      getMemberRoleAndUpdateCache$,
      args.state.orgId,
      args.state.userId,
      signal,
    );
    signal.throwIfAborted();

    if (!member) {
      throw new Error("You are not a member of this organization");
    }

    const connectionResult = await set(
      connectSlackWorkspace$,
      {
        userId: args.state.userId,
        orgId: args.state.orgId,
        orgRole: member.role,
        workspaceId: installation.slackWorkspaceId,
        slackUserId: oauthResult.authedUserId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (connectionResult.kind !== "ok") {
      return settingsErrorRedirect(
        connectionResult.message,
        args.state.publicBrand,
      );
    }

    await writeDb
      .update(slackOrgInstallations)
      .set({ publicBrand: args.state.publicBrand, updatedAt: nowDate() })
      .where(
        eq(
          slackOrgInstallations.slackWorkspaceId,
          installation.slackWorkspaceId,
        ),
      );
    signal.throwIfAborted();
    const brandedInstallation: SlackInstallation = {
      ...installation,
      publicBrand: args.state.publicBrand,
    };

    await set(
      publishSlackAdminSignal$,
      { orgId: args.state.orgId, topic: "slack:changed" },
      signal,
    );
    signal.throwIfAborted();

    set(
      notifyAfterConnect$,
      {
        installation: brandedInstallation,
        slackUserId: oauthResult.authedUserId,
        orgId: args.state.orgId,
        userId: args.state.userId,
        pendingPrompt: args.state.prompt,
      },
      signal,
    );

    return redirectResponse(
      appUrl(
        `/settings/slack?status=connected&workspace=${encodeURIComponent(installation.slackWorkspaceName ?? "")}`,
        args.state.publicBrand,
      ),
    );
  },
);

const callbackOauth$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$).raw;
  const canonicalRedirectUrl = getOAuthCanonicalRedirectUrl(request);
  if (canonicalRedirectUrl) {
    return redirectResponse(canonicalRedirectUrl);
  }
  const origin = getOAuthWebOrigin(request);
  const credentials = slackCredentials();
  if (!credentials) {
    return jsonErrorResponse("Slack integration is not configured", 503);
  }

  const query = get(queryOf(zeroSlackOauthContract.callback));
  const state = parseOAuthState(query.state);
  const redirectBrand = state?.publicBrand ?? get(publicBrand$);

  if (query.error) {
    return failedRedirect(query.error, redirectBrand);
  }

  if (!query.code) {
    return jsonErrorResponse("Missing authorization code", 400);
  }

  if (!state) {
    return failedRedirect("Invalid OAuth state.", redirectBrand);
  }
  if (state.flow === "connect") {
    return await set(
      handleConnectCallback$,
      {
        code: query.code,
        state,
        credentials,
        callbackOrigin: origin,
      },
      signal,
    );
  }

  return await set(
    handleInstallCallback$,
    {
      code: query.code,
      state,
      credentials,
      callbackOrigin: origin,
    },
    signal,
  );
});

export const slackOauthRoutes: readonly RouteEntry[] = [
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
