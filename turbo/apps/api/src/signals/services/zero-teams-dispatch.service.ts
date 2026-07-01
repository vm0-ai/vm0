import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { teamsOrgConnections } from "@vm0/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@vm0/db/schema/teams-org-installation";
import { teamsOrgThreadSessions } from "@vm0/db/schema/teams-org-thread-session";
import { teamsUserAgentPreferences } from "@vm0/db/schema/teams-user-agent-preference";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import type { TeamsInboundActivity } from "@vm0/api-contracts/contracts/zero-teams-bot";
import { and, eq, or } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";
import {
  resolveIntegrationModelRouteForUser$,
  type IntegrationModelRoutePin,
} from "./integration-model-route.service";
import { canReuseIntegrationSessionForModelRoute } from "./integration-session-model-compatibility.service";
import {
  teamsOrgCallbackPayloadSchema,
  type TeamsOrgCallbackPayload,
} from "./teams-org-callback-payload";
import { buildTeamsConnectUrlForActivity } from "./zero-teams-connect.service";
import { createZeroRun$ } from "./zero-runs-create.service";

const L = logger("TeamsDispatch");

type TeamsInstallation = typeof teamsOrgInstallations.$inferSelect;
type BoundTeamsInstallation = TeamsInstallation & { readonly orgId: string };
type TeamsConnection = typeof teamsOrgConnections.$inferSelect;
type TeamsMessageActivity = Extract<TeamsInboundActivity, { kind: "message" }>;

interface TeamsAgent {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

type EffectiveComposeResolution =
  | {
      readonly status: "resolved";
      readonly composeId: string;
      readonly agent: TeamsAgent;
    }
  | {
      readonly status: "not_configured" | "not_found" | "not_accessible";
    };

type TeamsMessageDispatchResult =
  | { readonly kind: "ignored" }
  | {
      readonly kind: "notice";
      readonly replyText: string;
      readonly connectUrl?: string;
    }
  | {
      readonly kind: "accepted" | "queued";
      readonly runId: string;
    }
  | {
      readonly kind: "failed";
      readonly replyText: string;
      readonly runId?: string;
    };

function callbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function optionalLine(
  label: string,
  value: string | null | undefined,
): string[] {
  const normalized = nonEmpty(value);
  return normalized ? [`${label}: ${normalized}`] : [];
}

async function installationForTenant(
  db: Db,
  tenantId: string,
): Promise<TeamsInstallation | undefined> {
  const [installation] = await db
    .select()
    .from(teamsOrgInstallations)
    .where(eq(teamsOrgInstallations.teamsTenantId, tenantId))
    .limit(1);
  return installation;
}

async function connectionForTeamsUser(
  db: Db,
  tenantId: string,
  teamsUserId: string,
): Promise<TeamsConnection | undefined> {
  const [connection] = await db
    .select()
    .from(teamsOrgConnections)
    .where(
      and(
        eq(teamsOrgConnections.teamsTenantId, tenantId),
        eq(teamsOrgConnections.teamsUserId, teamsUserId),
      ),
    )
    .limit(1);
  return connection;
}

async function resolveDefaultComposeId(
  db: Db,
  orgId: string,
): Promise<string | null> {
  const [metadata] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return metadata?.defaultAgentId ?? null;
}

async function getUserAgentPreference(
  db: Db,
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const [preference] = await db
    .select({ selectedComposeId: teamsUserAgentPreferences.selectedComposeId })
    .from(teamsUserAgentPreferences)
    .where(
      and(
        eq(teamsUserAgentPreferences.vm0UserId, vm0UserId),
        eq(teamsUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);
  return preference?.selectedComposeId ?? null;
}

async function getWorkspaceAgent(
  db: Db,
  composeId: string,
  orgId: string,
): Promise<TeamsAgent | undefined> {
  const [agent] = await db
    .select({
      id: zeroAgents.id,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.id, composeId), eq(zeroAgents.orgId, orgId)))
    .limit(1);
  return agent;
}

async function getVisibleWorkspaceAgent(args: {
  readonly db: Db;
  readonly composeId: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<TeamsAgent | undefined> {
  const [agent] = await args.db
    .select({
      id: zeroAgents.id,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.id, args.composeId),
        eq(zeroAgents.orgId, args.orgId),
        or(
          eq(zeroAgents.visibility, "public"),
          eq(zeroAgents.owner, args.userId),
        ),
      ),
    )
    .limit(1);
  return agent;
}

async function resolveEffectiveCompose(args: {
  readonly db: Db;
  readonly vm0UserId: string;
  readonly orgId: string;
}): Promise<EffectiveComposeResolution> {
  const override = await getUserAgentPreference(
    args.db,
    args.vm0UserId,
    args.orgId,
  );
  if (override) {
    const agent = await getVisibleWorkspaceAgent({
      db: args.db,
      composeId: override,
      orgId: args.orgId,
      userId: args.vm0UserId,
    });
    if (agent) {
      return { status: "resolved", composeId: override, agent };
    }
  }

  const defaultComposeId = await resolveDefaultComposeId(args.db, args.orgId);
  if (!defaultComposeId) {
    return { status: "not_configured" };
  }
  const configuredDefaultAgent = await getWorkspaceAgent(
    args.db,
    defaultComposeId,
    args.orgId,
  );
  if (!configuredDefaultAgent) {
    return { status: "not_found" };
  }
  const visibleDefaultAgent = await getVisibleWorkspaceAgent({
    db: args.db,
    composeId: defaultComposeId,
    orgId: args.orgId,
    userId: args.vm0UserId,
  });
  if (!visibleDefaultAgent) {
    return { status: "not_accessible" };
  }
  return {
    status: "resolved",
    composeId: defaultComposeId,
    agent: visibleDefaultAgent,
  };
}

async function resolveCompatibleTeamsThreadSession(args: {
  readonly db: Db;
  readonly connectionId: string;
  readonly conversationId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly modelRoute: IntegrationModelRoutePin | undefined;
}): Promise<string | undefined> {
  const [threadSession] = await args.db
    .select({ agentSessionId: teamsOrgThreadSessions.agentSessionId })
    .from(teamsOrgThreadSessions)
    .where(
      and(
        eq(teamsOrgThreadSessions.connectionId, args.connectionId),
        eq(teamsOrgThreadSessions.teamsConversationId, args.conversationId),
        eq(teamsOrgThreadSessions.teamsThreadId, args.threadId),
      ),
    )
    .limit(1);
  if (!threadSession?.agentSessionId) {
    return undefined;
  }

  const [agentSession] = await args.db
    .select({ agentComposeId: agentSessions.agentComposeId })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, threadSession.agentSessionId),
        eq(agentSessions.userId, args.userId),
      ),
    )
    .limit(1);
  if (agentSession?.agentComposeId !== args.composeId) {
    return undefined;
  }

  if (args.modelRoute) {
    const canReuseSession = await canReuseIntegrationSessionForModelRoute({
      db: args.db,
      sessionId: threadSession.agentSessionId,
      modelRoute: args.modelRoute,
    });
    if (!canReuseSession) {
      return undefined;
    }
  }

  return threadSession.agentSessionId;
}

function buildTeamsPrompt(args: {
  readonly activity: TeamsMessageActivity;
  readonly installation: TeamsInstallation;
}): string {
  const recipient = args.activity.recipient;
  return [
    "# Current Integration",
    "You are currently running inside: Microsoft Teams",
    `Tenant ID: ${args.activity.tenantId}`,
    ...optionalLine("Tenant name", args.activity.tenantName),
    ...optionalLine("Team ID", args.activity.teamId),
    ...optionalLine("Team name", args.activity.teamName),
    ...optionalLine("Channel ID", args.activity.channelId),
    `Conversation ID: ${args.activity.conversationId}`,
    ...optionalLine("Conversation type", args.activity.conversationType),
    `Thread ID: ${args.activity.threadId}`,
    ...optionalLine("Activity ID", args.activity.activityId),
    ...optionalLine("Teams app ID", args.activity.teamsAppId),
    ...optionalLine("Bot ID", recipient?.id ?? args.installation.botId),
    ...optionalLine("Bot name", recipient?.name ?? args.installation.botName),
    `Teams user ID: ${args.activity.sender.id}`,
    ...optionalLine("Teams user display name", args.activity.sender.name),
    ...optionalLine(
      "Teams user principal name",
      args.activity.sender.userPrincipalName,
    ),
  ].join("\n");
}

function callbackPayload(args: {
  readonly activity: TeamsMessageActivity;
  readonly installation: TeamsInstallation;
  readonly connection: TeamsConnection;
  readonly composeId: string;
  readonly existingSessionId: string | undefined;
}): TeamsOrgCallbackPayload {
  return teamsOrgCallbackPayloadSchema.parse({
    tenantId: args.activity.tenantId,
    tenantName: args.activity.tenantName,
    teamId: args.activity.teamId,
    teamName: args.activity.teamName,
    channelId: args.activity.channelId,
    conversationId: args.activity.conversationId,
    conversationType: args.activity.conversationType,
    threadId: args.activity.threadId,
    activityId: args.activity.activityId,
    serviceUrl: args.activity.serviceUrl,
    connectionId: args.connection.id,
    teamsUserId: args.activity.sender.id,
    teamsUserDisplayName: args.activity.sender.name,
    teamsUserPrincipalName: args.activity.sender.userPrincipalName,
    botId: args.activity.recipient?.id ?? args.installation.botId,
    botName: args.activity.recipient?.name ?? args.installation.botName,
    agentId: args.composeId,
    existingSessionId: args.existingSessionId ?? null,
  });
}

const runAgentForTeams$ = command(
  async (
    { set },
    args: {
      readonly activity: TeamsMessageActivity;
      readonly installation: BoundTeamsInstallation;
      readonly connection: TeamsConnection;
      readonly composeId: string;
      readonly sessionId: string | undefined;
      readonly apiStartTime: number;
      readonly modelRoute: IntegrationModelRoutePin | undefined;
    },
    signal: AbortSignal,
  ): Promise<TeamsMessageDispatchResult> => {
    const result = await set(
      createZeroRun$,
      {
        auth: {
          tokenType: "session",
          userId: args.connection.vm0UserId,
          orgId: args.installation.orgId,
          orgRole: "member",
        },
        body: {
          prompt: args.activity.text,
          agentId: args.composeId,
          sessionId: args.sessionId,
          ...(args.modelRoute?.modelProviderType
            ? { modelProvider: args.modelRoute.modelProviderType }
            : {}),
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "teams",
        appendSystemPrompt: buildTeamsPrompt({
          activity: args.activity,
          installation: args.installation,
        }),
        userInfoExtras: {
          teamsUserDisplayName: args.activity.sender.name ?? undefined,
          teamsUserPrincipalName:
            args.activity.sender.userPrincipalName ?? undefined,
          teamsUserId: args.activity.sender.id,
        },
        modelProviderId: args.modelRoute?.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          args.modelRoute?.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: args.modelRoute?.selectedModel ?? undefined,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        callbacks: [
          {
            internalKind: "teams:org",
            secret: callbackSecret(),
            payload: callbackPayload({
              activity: args.activity,
              installation: args.installation,
              connection: args.connection,
              composeId: args.composeId,
              existingSessionId: args.sessionId,
            }),
          },
        ],
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === 201) {
      return {
        kind: result.body.status === "queued" ? "queued" : "accepted",
        runId: result.body.runId,
      };
    }

    return {
      kind: "failed",
      replyText: await set(
        formatIntegrationRunError$,
        {
          orgId: args.installation.orgId,
          userId: args.connection.vm0UserId,
          code: result.body.error.code,
          message: result.body.error.message,
        },
        signal,
      ),
    };
  },
);

function connectNotice(
  activity: TeamsMessageActivity,
  installation: TeamsInstallation | null,
): TeamsMessageDispatchResult {
  const connectUrl = buildTeamsConnectUrlForActivity({
    activity,
    installation,
  });
  return {
    kind: "notice",
    replyText: connectUrl
      ? `Please connect your Microsoft Teams account to Zero first: ${connectUrl}`
      : "Please connect your Microsoft Teams account to Zero first.",
    ...(connectUrl ? { connectUrl } : {}),
  };
}

export const dispatchTeamsMessageToAgent$ = command(
  async (
    { set },
    args: {
      readonly activity: TeamsInboundActivity;
      readonly installation?: TeamsInstallation | null;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<TeamsMessageDispatchResult> => {
    if (args.activity.kind !== "message") {
      return { kind: "ignored" };
    }

    const activity = args.activity;
    const prompt = activity.text.trim();
    if (!prompt) {
      return {
        kind: "notice",
        replyText: "Please include a message for Zero.",
      };
    }

    const db = set(writeDb$);
    const installation =
      args.installation ??
      (await installationForTenant(db, activity.tenantId)) ??
      null;
    signal.throwIfAborted();

    if (!installation?.orgId) {
      return connectNotice(activity, installation);
    }
    const boundInstallation: BoundTeamsInstallation = {
      ...installation,
      orgId: installation.orgId,
    };

    const connection = await connectionForTeamsUser(
      db,
      activity.tenantId,
      activity.sender.id,
    );
    signal.throwIfAborted();

    if (!connection) {
      return connectNotice(activity, installation);
    }

    const effectiveCompose = await resolveEffectiveCompose({
      db,
      vm0UserId: connection.vm0UserId,
      orgId: boundInstallation.orgId,
    });
    signal.throwIfAborted();

    switch (effectiveCompose.status) {
      case "not_configured": {
        return {
          kind: "notice",
          replyText:
            "No agent is configured for this org. Please ask your org admin to set a default agent.",
        };
      }
      case "not_found": {
        return {
          kind: "notice",
          replyText:
            "The configured agent could not be found. Please contact your org admin.",
        };
      }
      case "not_accessible": {
        return {
          kind: "notice",
          replyText:
            "The configured agent is not available to your Microsoft Teams account.",
        };
      }
      case "resolved": {
        break;
      }
    }

    const modelRoute = await set(
      resolveIntegrationModelRouteForUser$,
      {
        orgId: boundInstallation.orgId,
        userId: connection.vm0UserId,
      },
      signal,
    );
    signal.throwIfAborted();

    const existingSessionId = await resolveCompatibleTeamsThreadSession({
      db,
      connectionId: connection.id,
      conversationId: activity.conversationId,
      threadId: activity.threadId,
      userId: connection.vm0UserId,
      composeId: effectiveCompose.composeId,
      modelRoute,
    });
    signal.throwIfAborted();

    const result = await set(
      runAgentForTeams$,
      {
        activity: { ...activity, text: prompt },
        installation: boundInstallation,
        connection,
        composeId: effectiveCompose.composeId,
        sessionId: existingSessionId,
        apiStartTime: args.apiStartTime,
        modelRoute,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.kind === "failed") {
      L.warn("Teams agent dispatch failed", {
        tenantId: activity.tenantId,
        conversationId: activity.conversationId,
        threadId: activity.threadId,
        userId: connection.vm0UserId,
        runId: result.runId,
      });
    }

    return result;
  },
);
