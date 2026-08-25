import { command, computed } from "ccstate";
import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { publicBrand$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
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

const connectInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const publicBrand = get(publicBrand$);
  signal.throwIfAborted();

  const bodyResult = await get(bodyResultOf(slackConnectContract.connect));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

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
          publicBrand,
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
