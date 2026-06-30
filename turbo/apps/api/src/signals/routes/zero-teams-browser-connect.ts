import { command } from "ccstate";
import { zeroTeamsBrowserConnectContract } from "@vm0/api-contracts/contracts/zero-teams-browser-connect";
import { teamsOrgInstallations } from "@vm0/db/schema/teams-org-installation";
import { eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { requiredAuthContext$ } from "../auth/auth-context";
import { request$ } from "../context/hono";
import { queryOf } from "../context/request";
import { db$ } from "../external/db";
import {
  connectTeamsInstallation$,
  publishTeamsChanged$,
} from "../services/zero-teams-connect.service";
import type { RouteEntry } from "../route-entry";

const L = logger("TeamsBrowserConnect");
const REDIRECT_STATUS = 307;

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

function appRedirect(path: string): Response {
  return redirectResponse(`${env("APP_URL")}${path}`);
}

function connectError(message: string): Response {
  return appRedirect(`/settings/teams?error=${encodeURIComponent(message)}`);
}

function connectSuccess(): Response {
  return appRedirect("/settings/teams?status=connected");
}

function signInRedirect(requestUrl: string): Response {
  const signInUrl = new URL("/sign-in", requestUrl);
  signInUrl.searchParams.set("redirect_url", requestUrl);
  return redirectResponse(signInUrl.toString());
}

const invalidConnectLinkMessage = "Invalid connect link.";
const installationNotFoundMessage =
  "Teams installation not found. Please install the Teams app first.";
const adminRequiredMessage = "Ask your org admin to connect first.";
const orgMismatchMessage =
  "Your active organization doesn't match this Teams installation. Please switch to the correct organization in the platform sidebar before connecting.";

const browserConnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  const auth = await set(requiredAuthContext$, {}, signal);
  signal.throwIfAborted();

  if ("status" in auth) {
    return signInRedirect(request.url);
  }

  const query = get(queryOf(zeroTeamsBrowserConnectContract.connect));
  const tenantId = query.tenantId;
  const teamsUserId = query.teamsUserId;

  if (!tenantId || !teamsUserId) {
    return connectError(invalidConnectLinkMessage);
  }

  const db = get(db$);
  const [installation] = await db
    .select()
    .from(teamsOrgInstallations)
    .where(eq(teamsOrgInstallations.teamsTenantId, tenantId))
    .limit(1);
  signal.throwIfAborted();

  if (!installation) {
    return connectError(installationNotFoundMessage);
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
    connectTeamsInstallation$,
    {
      userId: auth.userId,
      orgId,
      orgRole: auth.orgRole === "admin" ? "admin" : "member",
      tenantId,
      teamsUserId,
      teamsUserDisplayName: query.displayName,
      teamsUserPrincipalName: query.upn,
      teamId: installation.teamsTeamId ?? undefined,
      teamName: installation.teamsTeamName ?? undefined,
      serviceUrl: installation.serviceUrl ?? undefined,
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

  await set(publishTeamsChanged$, { orgId, userIds: [auth.userId] }, signal);
  signal.throwIfAborted();

  return connectSuccess();
});

export const zeroTeamsBrowserConnectRoutes: readonly RouteEntry[] = [
  {
    route: zeroTeamsBrowserConnectContract.connect,
    handler: browserConnect$,
  },
];
