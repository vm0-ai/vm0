import { command } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { teamsBrowserConnectContract } from "@okouai/api-contracts/contracts/teams-browser-connect";
import { appUrlForPublicBrand } from "@okouai/core/public-brand";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { teamsBotDisplayName } from "../../lib/teams-official-app";
import { requiredAuthContext$ } from "../auth/auth-context";
import { publicBrand$, request$ } from "../context/hono";
import { queryOf } from "../context/request";
import { db$ } from "../external/db";
import {
  connectTeamsInstallation$,
  publishTeamsChanged$,
} from "../services/teams-connect.service";
import type { RouteEntry } from "../route-entry";

const L = logger("TeamsBrowserConnect");
const REDIRECT_STATUS = 307;

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

function appRedirect(path: string, publicBrand: PublicBrand): Response {
  return redirectResponse(
    `${appUrlForPublicBrand(env("APP_URL"), publicBrand)}${path}`,
  );
}

function teamsSettingsParams(
  query: {
    readonly tenantId?: string;
    readonly tenantName?: string;
    readonly teamsUserId?: string;
    readonly teamsAadObjectId?: string;
    readonly teamsUserDisplayName?: string;
    readonly teamsUserPrincipalName?: string;
    readonly displayName?: string;
    readonly upn?: string;
    readonly teamId?: string;
    readonly teamName?: string;
    readonly botName?: string;
    readonly serviceUrl?: string;
    readonly conversationId?: string;
    readonly conversationType?: string;
    readonly activityId?: string;
    readonly channelId?: string;
    readonly threadId?: string;
    readonly orgId?: string;
  },
  extras: Readonly<Record<string, string | null | undefined>>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extras)) {
    if (value) {
      params.set(key, value);
    }
  }
  if (query.tenantId) {
    params.set("tenantId", query.tenantId);
  }
  if (query.tenantName) {
    params.set("tenantName", query.tenantName);
  }
  if (query.teamsUserId) {
    params.set("teamsUserId", query.teamsUserId);
  }
  if (query.teamsAadObjectId) {
    params.set("teamsAadObjectId", query.teamsAadObjectId);
  }
  if (query.displayName) {
    params.set("displayName", query.displayName);
  }
  if (query.teamsUserDisplayName) {
    params.set("teamsUserDisplayName", query.teamsUserDisplayName);
  }
  if (query.upn) {
    params.set("upn", query.upn);
  }
  if (query.teamsUserPrincipalName) {
    params.set("teamsUserPrincipalName", query.teamsUserPrincipalName);
  }
  if (query.teamId) {
    params.set("teamId", query.teamId);
  }
  if (query.teamName) {
    params.set("teamName", query.teamName);
  }
  if (query.serviceUrl) {
    params.set("serviceUrl", query.serviceUrl);
  }
  if (query.conversationId) {
    params.set("conversationId", query.conversationId);
  }
  if (query.conversationType) {
    params.set("conversationType", query.conversationType);
  }
  if (query.activityId) {
    params.set("activityId", query.activityId);
  }
  if (query.channelId) {
    params.set("channelId", query.channelId);
  }
  if (query.threadId) {
    params.set("threadId", query.threadId);
  }
  if (query.orgId) {
    params.set("orgId", query.orgId);
  }
  return params;
}

function connectError(
  message: string,
  query: Parameters<typeof teamsSettingsParams>[0] = {},
  publicBrand: PublicBrand = "vm0",
): Response {
  const params = teamsSettingsParams(query, { error: message });
  return appRedirect(`/settings/teams?${params.toString()}`, publicBrand);
}

function connectSuccess(
  query: Parameters<typeof teamsSettingsParams>[0],
  installation: {
    readonly teamsTenantName?: string | null;
    readonly teamsTeamName?: string | null;
    readonly botName?: string | null;
  },
  publicBrand: PublicBrand,
): Response {
  const params = teamsSettingsParams(query, {
    status: "connected",
    tenantName: installation.teamsTenantName,
    teamName: installation.teamsTeamName,
    botName: teamsBotDisplayName(installation.botName),
  });
  return appRedirect(`/settings/teams?${params.toString()}`, publicBrand);
}

function signInRedirect(
  requestUrl: string,
  publicBrand: PublicBrand,
): Response {
  const signInUrl = new URL(
    "/sign-in",
    appUrlForPublicBrand(env("APP_URL"), publicBrand),
  );
  signInUrl.searchParams.set("redirect_url", requestUrl);
  return redirectResponse(signInUrl.toString());
}

const invalidConnectLinkMessage = "Invalid connect link.";
const installationNotFoundMessage =
  "Teams installation not found. Please install the Teams app first.";
const adminRequiredMessage = "Ask your org admin to connect first.";
const orgMismatchMessage =
  "Your active organization doesn't match this Teams installation. Please switch to the correct organization in the platform sidebar before connecting.";

type TeamsBrowserConnectQuery = Parameters<typeof teamsSettingsParams>[0];
type TeamsOrgInstallation = typeof teamsOrgInstallations.$inferSelect;

function resolveBrowserConnectOrgId(args: {
  readonly query: TeamsBrowserConnectQuery;
  readonly activeOrgId?: string | null;
  readonly orgRole?: string | null;
  readonly userId: string;
  readonly installation: TeamsOrgInstallation;
}):
  | { readonly kind: "ok"; readonly orgId: string }
  | {
      readonly kind: "error";
      readonly message: string;
    } {
  const effectiveOrgId = args.query.orgId ?? args.activeOrgId;
  if (!args.installation.orgId) {
    if (!effectiveOrgId || args.orgRole !== "admin") {
      return { kind: "error", message: adminRequiredMessage };
    }
    return { kind: "ok", orgId: effectiveOrgId };
  }

  if (!effectiveOrgId || effectiveOrgId !== args.installation.orgId) {
    L.debug("Org check failed", {
      activeOrgId: args.activeOrgId,
      explicitOrgId: args.query.orgId,
      installationOrgId: args.installation.orgId,
      userId: args.userId,
    });
    return { kind: "error", message: orgMismatchMessage };
  }

  return { kind: "ok", orgId: args.installation.orgId };
}

const browserConnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  const publicBrand = get(publicBrand$);
  const auth = await set(requiredAuthContext$, {}, signal);
  signal.throwIfAborted();

  if ("status" in auth) {
    return signInRedirect(request.url, publicBrand);
  }

  const query = get(queryOf(teamsBrowserConnectContract.connect));
  const tenantId = query.tenantId;
  const teamsUserId = query.teamsUserId;
  const teamsAadObjectId = query.teamsAadObjectId;

  if (!tenantId || (!teamsUserId && !teamsAadObjectId)) {
    return connectError(invalidConnectLinkMessage, query, publicBrand);
  }

  const db = get(db$);
  const [installation] = await db
    .select()
    .from(teamsOrgInstallations)
    .where(eq(teamsOrgInstallations.teamsTenantId, tenantId))
    .limit(1);
  signal.throwIfAborted();

  if (!installation) {
    return connectError(installationNotFoundMessage, query, publicBrand);
  }

  const orgResolution = resolveBrowserConnectOrgId({
    query,
    activeOrgId: auth.orgId,
    orgRole: auth.orgRole,
    userId: auth.userId,
    installation,
  });
  if (orgResolution.kind === "error") {
    return connectError(orgResolution.message, query, publicBrand);
  }
  const orgId = orgResolution.orgId;

  const result = await set(
    connectTeamsInstallation$,
    {
      userId: auth.userId,
      orgId,
      orgRole: auth.orgRole === "admin" ? "admin" : "member",
      tenantId,
      publicBrand,
      tenantName: query.tenantName ?? installation.teamsTenantName ?? undefined,
      teamsUserId,
      teamsAadObjectId,
      teamsUserDisplayName: query.teamsUserDisplayName ?? query.displayName,
      teamsUserPrincipalName: query.teamsUserPrincipalName ?? query.upn,
      teamId: query.teamId ?? installation.teamsTeamId ?? undefined,
      teamName: query.teamName ?? installation.teamsTeamName ?? undefined,
      serviceUrl: query.serviceUrl ?? installation.serviceUrl ?? undefined,
      conversationId: query.conversationId,
      conversationType: query.conversationType,
      activityId: query.activityId,
      channelId: query.channelId,
      threadId: query.threadId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return connectError(result.message, query, publicBrand);
  }

  if (result.kind === "forbidden") {
    return connectError(result.message, query, publicBrand);
  }

  await set(publishTeamsChanged$, { orgId, userIds: [auth.userId] }, signal);
  signal.throwIfAborted();

  return connectSuccess(query, result.installation, publicBrand);
});

export const teamsBrowserConnectRoutes: readonly RouteEntry[] = [
  {
    route: teamsBrowserConnectContract.connect,
    handler: browserConnect$,
  },
];
