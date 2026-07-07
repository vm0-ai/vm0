import { command } from "ccstate";
import { integrationsTeamsMessageContract } from "@vm0/api-contracts/contracts/integrations";
import { teamsOrgInstallations } from "@vm0/db/schema/teams-org-installation";
import { eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$, type ReadonlyDb } from "../external/db";
import { sendTeamsMessage } from "../external/teams-bot-client";
import type { RouteEntry } from "../route-entry";

interface TeamsInstallation {
  readonly teamsTenantId: string;
  readonly serviceUrl: string | null;
}

function routeError<Status extends 400 | 401 | 403 | 404 | 502>(
  status: Status,
  message: string,
  code: string,
) {
  return { status, body: { error: { message, code } } };
}

async function loadInstallation(
  db: ReadonlyDb,
  orgId: string,
): Promise<TeamsInstallation | undefined> {
  const [installation] = await db
    .select({
      teamsTenantId: teamsOrgInstallations.teamsTenantId,
      serviceUrl: teamsOrgInstallations.serviceUrl,
    })
    .from(teamsOrgInstallations)
    .where(eq(teamsOrgInstallations.orgId, orgId))
    .limit(1);
  return installation;
}

function teamsErrorResponse(
  result: Extract<
    Awaited<ReturnType<typeof sendTeamsMessage>>,
    { readonly kind: "teams-error" }
  >,
) {
  return routeError(
    result.status >= 500 ? 502 : 400,
    `Microsoft Teams API error: ${result.error}`,
    "TEAMS_ERROR",
  );
}

const sendMessageInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsTeamsMessageContract.sendMessage),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const installation = await loadInstallation(get(db$), auth.orgId);
  signal.throwIfAborted();
  if (!installation) {
    return routeError(
      404,
      "No Microsoft Teams installation found for this organization",
      "NOT_FOUND",
    );
  }
  if (!installation.serviceUrl) {
    return routeError(
      404,
      "Microsoft Teams installation has no service URL yet. Send a message to the Teams bot first.",
      "NOT_FOUND",
    );
  }

  const result = await sendTeamsMessage({
    serviceUrl: installation.serviceUrl,
    conversationId: body.conversationId,
    activityId: body.activityId,
    tenantId: installation.teamsTenantId,
    text: body.text,
    signal,
  });
  signal.throwIfAborted();
  if (result.kind === "teams-error") {
    return teamsErrorResponse(result);
  }

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      activityId: result.activityId,
      conversationId: body.conversationId,
    },
  };
});

const teamsWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "teams:write",
} as const;

export const zeroIntegrationsTeamsMessageRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTeamsMessageContract.sendMessage,
    handler: authRoute(teamsWriteAuth, sendMessageInner$),
  },
];
