import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { teamsChatThreadRoutes } from "@vm0/db/schema/teams-chat-thread-route";
import { teamsOrgConnections } from "@vm0/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@vm0/db/schema/teams-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { and, countDistinct, eq, isNotNull } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import {
  deleteTeamsReaction,
  sendTeamsMessageReply,
} from "../external/teams-bot-client";
import { now, nowDate } from "../external/time";
import { settleIncludingAbort } from "../utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveIntegrationAgentResponsePresentation } from "./integration-agent-response-presentation.service";
import {
  teamsChatCallbackPayloadSchema,
  type TeamsDeliveryTarget,
} from "./teams-chat-callback-payload";

const L = logger("InternalCallbacksTeamsChat");
const TEAMS_THINKING_REACTION_TYPE = "1f4ad_thoughtballoon";

async function markDelivered(db: Db, callbackId: string): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({ status: "delivered", deliveredAt: nowDate() })
    .where(eq(agentRunCallbacks.id, callbackId));
}

async function markFailed(
  db: Db,
  callbackId: string,
  error: string,
): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({ status: "failed", lastError: error.slice(0, 4000) })
    .where(eq(agentRunCallbacks.id, callbackId));
}

function recordDelivery(args: {
  readonly runId: string;
  readonly startedAt: number;
  readonly success: boolean;
  readonly outcome: "delivered" | "failed" | "skipped_revoked";
}): void {
  recordSandboxOperation({
    sandboxType: "chat",
    actionType: "teams_chat_delivery",
    durationMs: Math.max(0, now() - args.startedAt),
    success: args.success,
    runId: args.runId,
    dimensions: { outcome: args.outcome },
  });
}

interface ClaimedTeamsChatDelivery {
  readonly runId: string;
  readonly payload: unknown;
}

async function claimTeamsChatDelivery(
  db: Db,
  callbackId: string,
): Promise<ClaimedTeamsChatDelivery | undefined> {
  const [callback] = await db
    .update(agentRunCallbacks)
    .set({ attempts: 1, lastAttemptAt: nowDate() })
    .where(
      and(
        eq(agentRunCallbacks.id, callbackId),
        eq(agentRunCallbacks.internalKind, "teams:chat"),
        eq(agentRunCallbacks.status, "pending"),
        eq(agentRunCallbacks.attempts, 0),
      ),
    )
    .returning({
      runId: agentRunCallbacks.runId,
      payload: agentRunCallbacks.payload,
    });
  return callback;
}

async function loadTeamsChatDeliveryContext(args: {
  readonly db: Db;
  readonly callback: ClaimedTeamsChatDelivery;
  readonly signal: AbortSignal;
}) {
  const payload = teamsChatCallbackPayloadSchema.parse(args.callback.payload);
  const [run] = await args.db
    .select({
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      chatThreadId: zeroRuns.chatThreadId,
      agentId: chatThreads.agentComposeId,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .innerJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
    .where(
      and(
        eq(agentRuns.id, args.callback.runId),
        eq(zeroRuns.triggerSource, "teams"),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!run?.chatThreadId) {
    throw new Error("Teams chat delivery run context is unavailable");
  }

  const [message] = await args.db
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.id, payload.chatMessageId),
        eq(chatMessages.runId, args.callback.runId),
        eq(chatMessages.chatThreadId, run.chatThreadId),
        eq(chatMessages.role, "assistant"),
        isNotNull(chatMessages.content),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!message?.content) {
    throw new Error("Teams chat delivery message is unavailable");
  }

  const [binding] = await args.db
    .select({
      serviceUrl: teamsOrgInstallations.serviceUrl,
    })
    .from(teamsChatThreadRoutes)
    .innerJoin(
      teamsOrgConnections,
      eq(teamsOrgConnections.id, teamsChatThreadRoutes.connectionId),
    )
    .innerJoin(
      teamsOrgInstallations,
      eq(
        teamsOrgInstallations.teamsTenantId,
        teamsOrgConnections.teamsTenantId,
      ),
    )
    .where(
      and(
        eq(teamsChatThreadRoutes.conversationId, payload.conversationId),
        eq(teamsChatThreadRoutes.threadId, payload.threadId),
        eq(teamsChatThreadRoutes.userId, run.userId),
        eq(teamsChatThreadRoutes.connectionId, payload.connectionId),
        eq(teamsOrgConnections.vm0UserId, run.userId),
        eq(teamsOrgConnections.teamsTenantId, payload.tenantId),
        eq(teamsOrgInstallations.orgId, run.orgId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return { payload, run, messageContent: message.content, binding };
}

async function countTeamsMentioners(args: {
  readonly db: Db;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly threadId: string;
}): Promise<number> {
  const [row] = await args.db
    .select({ count: countDistinct(teamsChatThreadRoutes.connectionId) })
    .from(teamsChatThreadRoutes)
    .innerJoin(
      teamsOrgConnections,
      eq(teamsOrgConnections.id, teamsChatThreadRoutes.connectionId),
    )
    .where(
      and(
        eq(teamsOrgConnections.teamsTenantId, args.tenantId),
        eq(teamsChatThreadRoutes.conversationId, args.conversationId),
        eq(teamsChatThreadRoutes.threadId, args.threadId),
      ),
    );
  return row?.count ?? 0;
}

function buildTeamsResponseText(args: {
  readonly mainText: string;
  readonly logsUrl: string | undefined;
  readonly footerText: string | undefined;
}): string {
  return [
    args.mainText,
    args.logsUrl ? `[Audit](${args.logsUrl})` : undefined,
    args.footerText ? `_${args.footerText}_` : undefined,
  ]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

async function deliverClaimedTeamsChatCallback(args: {
  readonly db: Db;
  readonly callback: ClaimedTeamsChatDelivery;
  readonly signal: AbortSignal;
}): Promise<"delivered" | "skipped_revoked"> {
  const { payload, run, messageContent, binding } =
    await loadTeamsChatDeliveryContext(args);
  if (!binding) {
    return "skipped_revoked";
  }

  const [mentionerCount, featureContext] = await Promise.all([
    countTeamsMentioners({
      db: args.db,
      tenantId: payload.tenantId,
      conversationId: payload.conversationId,
      threadId: payload.threadId,
    }),
    loadUserFeatureSwitchContext(args.db, run.orgId, run.userId),
  ]);
  args.signal.throwIfAborted();
  const replyTo =
    payload.teamsUserDisplayName ??
    payload.teamsUserPrincipalName ??
    payload.teamsUserId;
  const presentation = await resolveIntegrationAgentResponsePresentation({
    db: args.db,
    orgId: run.orgId,
    userId: run.userId,
    runId: args.callback.runId,
    agentId: run.agentId,
    replyToMention:
      payload.conversationType !== "personal" && mentionerCount > 1
        ? replyTo
        : undefined,
    getFeatureOverrides: () => {
      return Promise.resolve(featureContext.overrides ?? {});
    },
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  const serviceUrl = payload.serviceUrl.trim() || binding.serviceUrl || "";
  if (!serviceUrl) {
    throw new Error("Microsoft Teams serviceUrl is missing");
  }
  const result = await sendTeamsMessageReply({
    serviceUrl,
    conversationId: payload.conversationId,
    activityId: payload.activityId ?? undefined,
    tenantId: payload.tenantId,
    text: buildTeamsResponseText({
      mainText: messageContent,
      logsUrl: presentation.logsUrl,
      footerText: presentation.footerText,
    }),
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (result.kind === "teams-error") {
    throw new Error(`Microsoft Teams API error: ${result.error}`);
  }
  return "delivered";
}

export async function dispatchTeamsChatDeliveryOnce(
  db: Db,
  callbackId: string,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = now();
  signal.throwIfAborted();
  const callback = await claimTeamsChatDelivery(db, callbackId);
  if (!callback) {
    return;
  }

  const delivery = await settleIncludingAbort(
    deliverClaimedTeamsChatCallback({
      db,
      callback,
      signal,
    }),
  );
  if (!delivery.ok) {
    const message =
      delivery.error instanceof Error
        ? delivery.error.message
        : "Unknown error";
    await markFailed(db, callbackId, message);
    recordDelivery({
      runId: callback.runId,
      startedAt,
      success: false,
      outcome: "failed",
    });
    L.warn("Canonical Teams delivery failed", {
      callbackId,
      runId: callback.runId,
      error: delivery.error,
    });
    return;
  }

  await markDelivered(db, callbackId);
  recordDelivery({
    runId: callback.runId,
    startedAt,
    success: true,
    outcome: delivery.value,
  });
  if (delivery.value === "skipped_revoked") {
    L.debug("Skipped canonical Teams delivery after binding revocation", {
      callbackId,
      runId: callback.runId,
    });
  }
}

interface TeamsChatAdmissionFailureArgs {
  readonly db: Db;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly target: TeamsDeliveryTarget;
  readonly chatMessageId: string;
  readonly signal: AbortSignal;
}

interface TeamsAdmissionFailureContext {
  readonly messageContent: string;
  readonly installationServiceUrl: string | null;
}

async function loadTeamsAdmissionFailureContext(
  args: TeamsChatAdmissionFailureArgs,
): Promise<TeamsAdmissionFailureContext | undefined> {
  const [messageRows, bindingRows] = await Promise.all([
    args.db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, args.chatMessageId),
          eq(chatMessages.chatThreadId, args.chatThreadId),
          eq(chatMessages.role, "assistant"),
          isNotNull(chatMessages.content),
        ),
      )
      .limit(1),
    args.db
      .select({ serviceUrl: teamsOrgInstallations.serviceUrl })
      .from(teamsChatThreadRoutes)
      .innerJoin(
        teamsOrgConnections,
        eq(teamsOrgConnections.id, teamsChatThreadRoutes.connectionId),
      )
      .innerJoin(
        teamsOrgInstallations,
        eq(
          teamsOrgInstallations.teamsTenantId,
          teamsOrgConnections.teamsTenantId,
        ),
      )
      .where(
        and(
          eq(teamsChatThreadRoutes.connectionId, args.target.connectionId),
          eq(teamsChatThreadRoutes.conversationId, args.target.conversationId),
          eq(teamsChatThreadRoutes.threadId, args.target.threadId),
          eq(teamsChatThreadRoutes.userId, args.userId),
          eq(teamsOrgConnections.vm0UserId, args.userId),
          eq(teamsOrgConnections.teamsTenantId, args.target.tenantId),
          eq(teamsOrgInstallations.orgId, args.orgId),
        ),
      )
      .limit(1),
  ]);
  args.signal.throwIfAborted();
  const message = messageRows[0];
  const binding = bindingRows[0];
  if (!message?.content || !binding) {
    return undefined;
  }
  return {
    messageContent: message.content,
    installationServiceUrl: binding.serviceUrl,
  };
}

interface TeamsAdmissionFailurePresentation {
  readonly logsUrl: string | undefined;
  readonly footerText: string | undefined;
}

async function resolveTeamsAdmissionFailurePresentation(
  args: TeamsChatAdmissionFailureArgs,
): Promise<TeamsAdmissionFailurePresentation> {
  const [mentionerCount, featureContext, orgRows, agentRows] =
    await Promise.all([
      countTeamsMentioners({
        db: args.db,
        tenantId: args.target.tenantId,
        conversationId: args.target.conversationId,
        threadId: args.target.threadId,
      }),
      loadUserFeatureSwitchContext(args.db, args.orgId, args.userId),
      args.db
        .select({ defaultAgentId: orgMetadata.defaultAgentId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.orgId))
        .limit(1),
      args.db
        .select({ displayName: zeroAgents.displayName, name: zeroAgents.name })
        .from(zeroAgents)
        .where(eq(zeroAgents.id, args.agentId))
        .limit(1),
    ]);
  args.signal.throwIfAborted();

  const footerParts: string[] = [];
  const agentLabel = agentRows[0]?.displayName ?? agentRows[0]?.name;
  if (agentLabel && args.agentId !== orgRows[0]?.defaultAgentId) {
    footerParts.push(`Sent via ${agentLabel}`);
  }
  if (args.target.conversationType !== "personal" && mentionerCount > 1) {
    footerParts.push(
      `Reply to ${
        args.target.teamsUserDisplayName ??
        args.target.teamsUserPrincipalName ??
        args.target.teamsUserId
      }`,
    );
  }
  const logsUrl = isFeatureEnabled(FeatureSwitchKey.ZeroDebug, featureContext)
    ? `${env("APP_URL").replace(/\/$/u, "")}/activities`
    : undefined;
  return {
    logsUrl,
    footerText: footerParts.length > 0 ? footerParts.join(" · ") : undefined,
  };
}

async function clearTeamsAdmissionThinkingReaction(args: {
  readonly target: TeamsDeliveryTarget;
  readonly serviceUrl: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.target.conversationType === "personal" || !args.target.activityId) {
    return;
  }
  const clearResult = await deleteTeamsReaction({
    serviceUrl: args.serviceUrl,
    conversationId: args.target.conversationId,
    activityId: args.target.activityId,
    tenantId: args.target.tenantId,
    reactionType: TEAMS_THINKING_REACTION_TYPE,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (clearResult.kind === "teams-error") {
    L.warn("Failed to clear Teams admission thinking reaction", {
      conversationId: args.target.conversationId,
      activityId: args.target.activityId,
      error: clearResult.error,
    });
  }
}

export async function deliverTeamsChatAdmissionFailure(
  args: TeamsChatAdmissionFailureArgs,
): Promise<void> {
  const context = await loadTeamsAdmissionFailureContext(args);
  if (!context) {
    return;
  }
  const presentation = await resolveTeamsAdmissionFailurePresentation(args);
  const serviceUrl =
    args.target.serviceUrl.trim() || context.installationServiceUrl || "";
  if (!serviceUrl) {
    throw new Error("Microsoft Teams serviceUrl is missing");
  }
  const result = await sendTeamsMessageReply({
    serviceUrl,
    conversationId: args.target.conversationId,
    activityId: args.target.activityId ?? undefined,
    tenantId: args.target.tenantId,
    text: buildTeamsResponseText({
      mainText: context.messageContent,
      logsUrl: presentation.logsUrl,
      footerText: presentation.footerText,
    }),
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  await clearTeamsAdmissionThinkingReaction({
    target: args.target,
    serviceUrl,
    signal: args.signal,
  });
  if (result.kind === "teams-error") {
    throw new Error(`Microsoft Teams API error: ${result.error}`);
  }
}
