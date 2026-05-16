import { command } from "ccstate";
import { zeroSlackBrowserConnectContract } from "@vm0/api-contracts/contracts/zero-slack-browser-connect";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { eq } from "drizzle-orm";

import { requiredAuthContext$ } from "../auth/auth-context";
import { request$ } from "../context/hono";
import { queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$ } from "../external/db";
import { logger } from "../../lib/log";
import { env } from "../../lib/env";
import {
  connectSlackWorkspace$,
  notifySlackConnect$,
  publishSlackAdminSignal$,
} from "../services/zero-slack-connect.service";
import { tapError } from "../utils";
import type { RouteEntry } from "../route";

const L = logger("SlackBrowserConnect");
const REDIRECT_STATUS = 307;

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

function appRedirect(path: string): Response {
  return redirectResponse(`${env("VM0_WEB_URL")}${path}`);
}

function connectError(message: string): Response {
  return appRedirect(`/slack/connect?error=${encodeURIComponent(message)}`);
}

function connectSuccess(): Response {
  return appRedirect("/slack/connect?status=connected");
}

function signInRedirect(requestUrl: string): Response {
  const signInUrl = new URL("/sign-in", requestUrl);
  signInUrl.searchParams.set("redirect_url", requestUrl);
  return redirectResponse(signInUrl.toString());
}

const invalidConnectLinkMessage = "Invalid connect link.";
const workspaceNotFoundMessage =
  "Workspace not found. Please install the Slack app first.";
const adminRequiredMessage = "Ask your org admin to connect first.";
const orgMismatchMessage =
  "Your active organization doesn't match this Slack workspace. Please switch to the correct organization in the platform sidebar before connecting.";

const browserConnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  const auth = await set(requiredAuthContext$, {}, signal);
  signal.throwIfAborted();

  if ("status" in auth) {
    return signInRedirect(request.url);
  }

  const query = get(queryOf(zeroSlackBrowserConnectContract.connect));
  const workspaceId = query.w;
  const slackUserId = query.u;
  const channelId = query.c;
  const threadTs = query.t;

  if (!workspaceId || !slackUserId) {
    return connectError(invalidConnectLinkMessage);
  }

  const db = get(db$);
  const [installation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);
  signal.throwIfAborted();

  if (!installation) {
    return connectError(workspaceNotFoundMessage);
  }

  const effectiveOrgId = query.orgId ?? auth.orgId;
  if (!installation.orgId) {
    if (!effectiveOrgId || auth.orgRole !== "admin") {
      return connectError(adminRequiredMessage);
    }
  } else if (!effectiveOrgId || effectiveOrgId !== installation.orgId) {
    L.debug("Org check failed", {
      activeOrgId: auth.orgId,
      explicitOrgId: query.orgId,
      installationOrgId: installation.orgId,
      userId: auth.userId,
    });
    return connectError(orgMismatchMessage);
  }

  const orgId = installation.orgId ?? effectiveOrgId;
  if (!orgId) {
    return connectError(adminRequiredMessage);
  }

  const result = await set(
    connectSlackWorkspace$,
    {
      userId: auth.userId,
      orgId,
      orgRole: auth.orgRole === "admin" ? "admin" : "member",
      workspaceId,
      slackUserId,
      channelId,
      threadTs,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return connectError(result.message);
  }

  if (result.kind === "forbidden") {
    return connectError(result.message);
  }

  await set(
    publishSlackAdminSignal$,
    { orgId, topic: "slack:changed" },
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
          orgId,
          channelId: result.channelId,
          threadTs: result.threadTs,
        },
        signal,
      ),
      (error) => {
        L.warn("Failed to notify connect success", { error });
      },
    ),
  );

  return connectSuccess();
});

export const zeroSlackBrowserConnectRoutes: readonly RouteEntry[] = [
  {
    route: zeroSlackBrowserConnectContract.connect,
    handler: browserConnect$,
  },
];
