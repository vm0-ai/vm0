import { command, computed } from "ccstate";
import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { isFeatureEnabled, FeatureSwitchKey } from "@okouai/core";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { db$ } from "../external/db";
import { getOAuthApiOrigin } from "../../lib/oauth-origin";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { buildSlackConnectorOAuthStartUrl } from "../services/slack-connector-oauth-state";
import { waitUntil } from "../context/wait-until";
import { logger } from "../../lib/log";
import {
  connectSlackWorkspace$,
  notifySlackConnect$,
  publishSlackAdminSignal$,
  slackConnectStatus,
} from "../services/slack-connect.service";
import { tapError } from "../utils";
import type { RouteEntry } from "../route-entry";

const L = logger("SlackConnect");

const getSlackConnectStatusInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    slackConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: "orgRole" in auth && auth.orgRole === "admin",
    }),
  );
  return { status: 200 as const, body };
});

const startConnectorOAuth$ = command(
  async (
    { get },
    body: {
      readonly workspaceId: string;
      readonly slackUserId: string;
      readonly channelId?: string;
      readonly threadTs?: string;
    },
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    const [installation] = await get(db$)
      .select({ orgId: slackOrgInstallations.orgId })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, body.workspaceId))
      .limit(1);
    signal.throwIfAborted();
    if (
      !installation ||
      (installation.orgId !== null && installation.orgId !== auth.orgId)
    ) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Slack workspace not found", code: "NOT_FOUND" },
        },
      };
    }
    if (installation.orgId === null && auth.orgRole !== "admin") {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Only admins can connect a Slack workspace",
            code: "FORBIDDEN",
          },
        },
      };
    }
    return {
      status: 202 as const,
      body: {
        authorizationUrl: buildSlackConnectorOAuthStartUrl(
          getOAuthApiOrigin(get(request$).raw),
          {
            flow: "connect",
            orgId: auth.orgId,
            userId: auth.userId,
            workspaceId: body.workspaceId,
            slackUserId: body.slackUserId,
            channelId: body.channelId,
            threadTs: body.threadTs,
          },
        ),
      },
    };
  },
);

const connectInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  signal.throwIfAborted();

  const bodyResult = await get(bodyResultOf(slackConnectContract.connect));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  if (body.requestUserScopes) {
    const features = await get(
      userFeatureSwitchContext(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    if (isFeatureEnabled(FeatureSwitchKey.SlackOAuthConnector, features)) {
      return await set(startConnectorOAuth$, body, signal);
    }
  }

  const result = await set(
    connectSlackWorkspace$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      orgRole:
        "orgRole" in auth && auth.orgRole === "admin" ? "admin" : "member",
      workspaceId: body.workspaceId,
      slackUserId: body.slackUserId,
      channelId: body.channelId,
      threadTs: body.threadTs,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return {
      status: 404 as const,
      body: {
        error: { message: result.message, code: "NOT_FOUND" },
      },
    };
  }

  if (result.kind === "forbidden") {
    return {
      status: 403 as const,
      body: {
        error: { message: result.message, code: "FORBIDDEN" },
      },
    };
  }

  await set(
    publishSlackAdminSignal$,
    { orgId: auth.orgId, topic: "slack:changed" },
    signal,
  );
  signal.throwIfAborted();

  waitUntil(
    tapError(
      set(
        notifySlackConnect$,
        {
          installation: result.installation,
          slackUserId: result.slackUserId,
          orgId: auth.orgId,
          userId: auth.userId,
          channelId: result.channelId,
          threadTs: result.threadTs,
        },
        signal,
      ),
      (error) => {
        L.error("notifySlackConnect failed", {
          workspaceId: result.installation.slackWorkspaceId,
          error,
        });
      },
    ),
  );

  return {
    status: 200 as const,
    body: {
      success: true as const,
      connectionId: result.connectionId,
      role: result.role,
    },
  };
});

const slackConnectAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const slackConnectWriteAuth = {
  ...slackConnectAuth,
  requiredCapability: "slack:write",
} as const;

export const slackConnectRoutes: readonly RouteEntry[] = [
  {
    route: slackConnectContract.getStatus,
    handler: authRoute(slackConnectAuth, getSlackConnectStatusInner$),
  },
  {
    route: slackConnectContract.connect,
    handler: authRoute(slackConnectWriteAuth, connectInner$),
  },
];
