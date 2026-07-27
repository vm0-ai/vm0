import { command } from "ccstate";
import { formatRunErrorForExternalSurface } from "@vm0/api-contracts/contracts/errors";
import {
  getFrameworkForType,
  modelProviderTypeSchema,
} from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { teamsChatThreadRoutes } from "@vm0/db/schema/teams-chat-thread-route";
import { teamsOrgConnections } from "@vm0/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@vm0/db/schema/teams-org-installation";
import { teamsOrgThreadSessions } from "@vm0/db/schema/teams-org-thread-session";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, isNull } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import {
  deleteTeamsReaction,
  sendTeamsMessageReply,
  sendTeamsTypingActivity,
} from "../external/teams-bot-client";
import { nowDate } from "../external/time";
import { bestEffort } from "../utils";
import {
  loadUserFeatureSwitchContext,
  userFeatureSwitchOverrides,
} from "./feature-switches.service";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import { formatRunErrorForRunOwner$ } from "./run-error-format.service";
import { getRunOutputText } from "./run-output.service";
import { saveRunSummary, saveRunSummary$ } from "./run-summary.service";
import {
  teamsOrgCallbackPayloadSchema,
  type TeamsOrgCallbackPayload,
} from "./teams-org-callback-payload";

const L = logger("InternalCallbacksTeamsOrg");
const ORG_SENTINEL_USER_ID = "__org__";
const TEAMS_THINKING_REACTION_TYPE = "1f4ad_thoughtballoon";

type TerminalStatus = "completed" | "failed";

interface RunContext {
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly sessionId: string | null;
  readonly lastEventSequence: number | null;
  readonly chatThreadId: string | null;
}

interface TeamsInstallation {
  readonly orgId: string | null;
  readonly serviceUrl: string | null;
}

type TeamsOrgCallbackResult =
  | { readonly status: 200; readonly body: { readonly success: true } }
  | {
      readonly status: 400 | 404 | 502;
      readonly body: { readonly error: string };
    };

type TeamsOrgInternalCallbackResult =
  | { readonly success: true; readonly skipped?: true }
  | {
      readonly success: false;
      readonly error: string;
      readonly status: 400 | 404 | 502;
    };

function successResponse(): {
  readonly status: 200;
  readonly body: { readonly success: true };
} {
  return { status: 200, body: { success: true } };
}

function errorResponse(
  status: 400 | 404 | 502,
  message: string,
): {
  readonly status: 400 | 404 | 502;
  readonly body: { readonly error: string };
} {
  return { status, body: { error: message } };
}

function parsePayload(payload: unknown): TeamsOrgCallbackPayload | null {
  const result = teamsOrgCallbackPayloadSchema.safeParse(payload);
  return result.success ? result.data : null;
}

function dispatchResultFromResponse(
  result: TeamsOrgCallbackResult,
): TeamsOrgInternalCallbackResult {
  if (result.status === 200) {
    return { success: true };
  }
  return {
    success: false,
    status: result.status,
    error: result.body.error,
  };
}

function buildLogsUrl(runId: string): string {
  return `${env("APP_URL")}/activities/${encodeURIComponent(runId)}`;
}

async function loadInstallation(args: {
  readonly db: Db;
  readonly tenantId: string;
  readonly signal: AbortSignal;
}): Promise<TeamsInstallation | undefined> {
  const [installation] = await args.db
    .select({
      orgId: teamsOrgInstallations.orgId,
      serviceUrl: teamsOrgInstallations.serviceUrl,
    })
    .from(teamsOrgInstallations)
    .where(eq(teamsOrgInstallations.teamsTenantId, args.tenantId))
    .limit(1);
  args.signal.throwIfAborted();
  return installation;
}

async function loadRunContext(args: {
  readonly db: Db;
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<RunContext | undefined> {
  const [run] = await args.db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      prompt: agentRuns.prompt,
      sessionId: agentRuns.sessionId,
      lastEventSequence: agentRuns.lastEventSequence,
      chatThreadId: zeroRuns.chatThreadId,
    })
    .from(agentRuns)
    .leftJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  args.signal.throwIfAborted();
  return run;
}

async function resolveRunSelectedModel(
  db: Db,
  runId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ selectedModel: zeroRuns.selectedModel })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row?.selectedModel ?? undefined;
}

async function resolveOrgDefaultModelProviderSelectedModel(
  db: Db,
  orgId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({
      type: modelProviders.type,
      selectedModel: modelProviders.selectedModel,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.isDefault, true),
      ),
    );
  const row = rows.find((candidate) => {
    const parsed = modelProviderTypeSchema.safeParse(candidate.type);
    return parsed.success && getFrameworkForType(parsed.data) === "claude-code";
  });
  return row?.selectedModel ?? undefined;
}

async function resolveModelLabel(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly runId: string;
}): Promise<string | undefined> {
  const selectedModel = await resolveRunSelectedModel(args.db, args.runId);
  const model =
    selectedModel ??
    (await resolveOrgDefaultModelProviderSelectedModel(args.db, args.orgId));
  return model ? getModelDisplayName(model) : undefined;
}

async function resolveRespondedByLabel(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly composeId: string;
}): Promise<string | undefined> {
  const [orgRow] = await args.db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);

  if (args.composeId === orgRow?.defaultAgentId) {
    return undefined;
  }

  const [agent] = await args.db
    .select({ displayName: zeroAgents.displayName, name: zeroAgents.name })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, args.composeId))
    .limit(1);
  const label = agent?.displayName ?? agent?.name;
  return label ? `Responded by ${label}` : undefined;
}

async function countThreadMentioners(args: {
  readonly db: Db;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly threadId: string;
  readonly currentConnectionId: string;
}): Promise<number> {
  const rows = await args.db
    .select({ connectionId: teamsOrgThreadSessions.connectionId })
    .from(teamsOrgThreadSessions)
    .innerJoin(
      teamsOrgConnections,
      eq(teamsOrgThreadSessions.connectionId, teamsOrgConnections.id),
    )
    .where(
      and(
        eq(teamsOrgConnections.teamsTenantId, args.tenantId),
        eq(teamsOrgThreadSessions.teamsConversationId, args.conversationId),
        eq(teamsOrgThreadSessions.teamsThreadId, args.threadId),
      ),
    );
  return new Set([
    args.currentConnectionId,
    ...rows.map((row) => {
      return row.connectionId;
    }),
  ]).size;
}

async function resolveFooterText(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly runId: string;
  readonly payload: TeamsOrgCallbackPayload;
}): Promise<string | undefined> {
  const [respondedBy, mentionerCount, modelLabel] = await Promise.all([
    resolveRespondedByLabel({
      db: args.db,
      orgId: args.orgId,
      composeId: args.payload.agentId,
    }),
    countThreadMentioners({
      db: args.db,
      tenantId: args.payload.tenantId,
      conversationId: args.payload.conversationId,
      threadId: args.payload.threadId,
      currentConnectionId: args.payload.connectionId,
    }),
    resolveModelLabel({
      db: args.db,
      orgId: args.orgId,
      runId: args.runId,
    }),
  ]);

  const parts: string[] = [];
  if (respondedBy) {
    parts.push(respondedBy);
  }
  if (args.payload.conversationType !== "personal" && mentionerCount > 1) {
    const replyTo =
      args.payload.teamsUserDisplayName ??
      args.payload.teamsUserPrincipalName ??
      args.payload.teamsUserId;
    if (replyTo) {
      parts.push(`Reply to ${replyTo}`);
    }
  }
  if (modelLabel) {
    parts.push(modelLabel);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

async function resolveAuditLogsUrl(args: {
  readonly runId: string;
  readonly run: RunContext | undefined;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  if (!args.run) {
    return undefined;
  }

  const overrides = await args.getFeatureOverrides(
    args.run.orgId,
    args.run.userId,
  );
  args.signal.throwIfAborted();
  const typedOverrides =
    Object.keys(overrides).length > 0
      ? (overrides as Partial<Record<FeatureSwitchKey, boolean>>)
      : undefined;
  const enabled = isFeatureEnabled(FeatureSwitchKey.ZeroDebug, {
    userId: args.run.userId,
    orgId: args.run.orgId,
    overrides: typedOverrides,
  });
  return enabled ? buildLogsUrl(args.runId) : undefined;
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

async function resolveCompletionText(args: {
  readonly runId: string;
  readonly status: TerminalStatus;
  readonly run: RunContext | undefined;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  if (args.status === "failed") {
    return undefined;
  }

  const output = await getRunOutputText(args.runId, {
    waitForOutput: false,
    knownLastEventSequence: args.run?.lastEventSequence,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  return output;
}

function teamsApiCallbackError(
  result: Extract<
    Awaited<ReturnType<typeof sendTeamsMessageReply>>,
    { readonly kind: "teams-error" }
  >,
): {
  readonly status: 400 | 502;
  readonly body: { readonly error: string };
} {
  return {
    status: result.status >= 500 ? 502 : 400,
    body: {
      error: `Microsoft Teams API error: ${result.error}`,
    },
  };
}

function resolveServiceUrl(args: {
  readonly payload: TeamsOrgCallbackPayload;
  readonly installation: TeamsInstallation;
}): string {
  return args.payload.serviceUrl.trim() || args.installation.serviceUrl || "";
}

async function connectionStillExists(args: {
  readonly db: Db;
  readonly payload: TeamsOrgCallbackPayload;
}): Promise<boolean> {
  const [connection] = await args.db
    .select({ id: teamsOrgConnections.id })
    .from(teamsOrgConnections)
    .where(
      and(
        eq(teamsOrgConnections.id, args.payload.connectionId),
        eq(teamsOrgConnections.teamsTenantId, args.payload.tenantId),
      ),
    )
    .limit(1);
  return Boolean(connection);
}

async function saveOrgThreadSession(args: {
  readonly db: Db;
  readonly runId: string;
  readonly payload: TeamsOrgCallbackPayload;
  readonly run: RunContext | undefined;
  readonly status: TerminalStatus;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.status === "failed" || !args.run) {
    return;
  }

  const agentSessionId = args.payload.existingSessionId ?? args.run.sessionId;
  if (!agentSessionId) {
    return;
  }

  if (
    !(await connectionStillExists({
      db: args.db,
      payload: args.payload,
    }))
  ) {
    return;
  }
  args.signal.throwIfAborted();

  if (!args.payload.existingSessionId) {
    await args.db
      .insert(teamsOrgThreadSessions)
      .values({
        connectionId: args.payload.connectionId,
        teamsConversationId: args.payload.conversationId,
        teamsChannelId: args.payload.channelId,
        teamsThreadId: args.payload.threadId,
        agentSessionId,
      })
      .onConflictDoUpdate({
        target: [
          teamsOrgThreadSessions.connectionId,
          teamsOrgThreadSessions.teamsConversationId,
          teamsOrgThreadSessions.teamsThreadId,
        ],
        set: {
          agentSessionId,
          teamsChannelId: args.payload.channelId,
          updatedAt: nowDate(),
        },
      });
    args.signal.throwIfAborted();
  }

  const [route] = await args.db
    .select({ chatThreadId: teamsChatThreadRoutes.chatThreadId })
    .from(teamsChatThreadRoutes)
    .where(
      and(
        eq(teamsChatThreadRoutes.connectionId, args.payload.connectionId),
        eq(teamsChatThreadRoutes.conversationId, args.payload.conversationId),
        eq(teamsChatThreadRoutes.threadId, args.payload.threadId),
        eq(teamsChatThreadRoutes.userId, args.run.userId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!route) {
    return;
  }

  await args.db
    .update(chatThreads)
    .set({
      agentSessionId,
      agentSessionRunId: args.runId,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(chatThreads.id, route.chatThreadId),
        isNull(chatThreads.agentSessionId),
      ),
    );
  args.signal.throwIfAborted();
}

async function handleProgress(args: {
  readonly payload: TeamsOrgCallbackPayload;
  readonly signal: AbortSignal;
}): Promise<TeamsOrgCallbackResult> {
  if (
    args.payload.conversationType !== "personal" &&
    args.payload.activityId !== null
  ) {
    return successResponse();
  }

  await bestEffort(
    sendTeamsTypingActivity({
      serviceUrl: args.payload.serviceUrl,
      conversationId: args.payload.conversationId,
      tenantId: args.payload.tenantId,
      signal: args.signal,
    }),
    args.signal,
  );
  return successResponse();
}

async function clearTeamsThinkingReaction(args: {
  readonly payload: TeamsOrgCallbackPayload;
  readonly serviceUrl: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (
    args.payload.conversationType === "personal" ||
    args.payload.activityId === null
  ) {
    return;
  }

  await bestEffort(
    deleteTeamsReaction({
      serviceUrl: args.serviceUrl,
      conversationId: args.payload.conversationId,
      activityId: args.payload.activityId,
      tenantId: args.payload.tenantId,
      reactionType: TEAMS_THINKING_REACTION_TYPE,
      signal: args.signal,
    }),
    args.signal,
  );
}

async function handleCanonicalChatCompletion(args: {
  readonly db: Db;
  readonly runId: string;
  readonly status: TerminalStatus;
  readonly payload: TeamsOrgCallbackPayload;
  readonly signal: AbortSignal;
}): Promise<TeamsOrgCallbackResult> {
  const installation = await loadInstallation({
    db: args.db,
    tenantId: args.payload.tenantId,
    signal: args.signal,
  });
  if (!installation) {
    return errorResponse(404, "Microsoft Teams installation not found");
  }
  const serviceUrl = resolveServiceUrl({
    payload: args.payload,
    installation,
  });
  if (!serviceUrl) {
    return errorResponse(400, "Microsoft Teams serviceUrl is missing");
  }
  const run = await loadRunContext({
    db: args.db,
    runId: args.runId,
    signal: args.signal,
  });
  if (run && installation.orgId !== run.orgId) {
    return errorResponse(404, "Microsoft Teams installation not found");
  }
  await clearTeamsThinkingReaction({
    payload: args.payload,
    serviceUrl,
    signal: args.signal,
  });
  await saveOrgThreadSession({
    db: args.db,
    runId: args.runId,
    payload: args.payload,
    run,
    status: args.status,
    signal: args.signal,
  });
  return successResponse();
}

async function handleCompletion(args: {
  readonly db: Db;
  readonly runId: string;
  readonly status: TerminalStatus;
  readonly error: string | undefined;
  readonly payload: TeamsOrgCallbackPayload;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly formatRunError: (params: {
    readonly runId: string;
    readonly chatThreadId: string | null | undefined;
    readonly errorMessage: string;
  }) => Promise<string>;
  readonly saveRunSummary: (
    runId: string,
    prompt: string,
    resultText: string,
  ) => Promise<void>;
  readonly signal: AbortSignal;
}): Promise<TeamsOrgCallbackResult> {
  const installation = await loadInstallation({
    db: args.db,
    tenantId: args.payload.tenantId,
    signal: args.signal,
  });
  if (!installation) {
    L.error("Teams org installation not found", {
      tenantId: args.payload.tenantId,
    });
    return errorResponse(404, "Microsoft Teams installation not found");
  }

  const run = await loadRunContext({
    db: args.db,
    runId: args.runId,
    signal: args.signal,
  });
  if (run && installation.orgId !== run.orgId) {
    L.warn("Teams org installation no longer belongs to run org", {
      tenantId: args.payload.tenantId,
      runId: args.runId,
      installationOrgId: installation.orgId,
      runOrgId: run.orgId,
    });
    return errorResponse(404, "Microsoft Teams installation not found");
  }

  const serviceUrl = resolveServiceUrl({
    payload: args.payload,
    installation,
  });
  if (!serviceUrl) {
    return errorResponse(400, "Microsoft Teams serviceUrl is missing");
  }

  const output = await resolveCompletionText({
    runId: args.runId,
    status: args.status,
    run,
    signal: args.signal,
  });
  const logsUrl = await resolveAuditLogsUrl({
    runId: args.runId,
    run,
    getFeatureOverrides: args.getFeatureOverrides,
    signal: args.signal,
  });
  const footerText = run
    ? await resolveFooterText({
        db: args.db,
        orgId: run.orgId,
        runId: args.runId,
        payload: args.payload,
      })
    : undefined;
  args.signal.throwIfAborted();

  const errorText =
    args.status === "failed"
      ? await args.formatRunError({
          runId: args.runId,
          chatThreadId: run?.chatThreadId,
          errorMessage: args.error ?? "Agent execution failed.",
        })
      : undefined;
  args.signal.throwIfAborted();

  const responseText = buildTeamsResponseText({
    mainText:
      args.status === "failed"
        ? (errorText ?? "Agent execution failed.")
        : (output ?? "Task completed successfully."),
    logsUrl,
    footerText,
  });
  const sendResult = await sendTeamsMessageReply({
    serviceUrl,
    conversationId: args.payload.conversationId,
    activityId: args.payload.activityId ?? undefined,
    tenantId: args.payload.tenantId,
    text: responseText,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (sendResult.kind === "teams-error") {
    return teamsApiCallbackError(sendResult);
  }

  await clearTeamsThinkingReaction({
    payload: args.payload,
    serviceUrl,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  await saveOrgThreadSession({
    db: args.db,
    runId: args.runId,
    payload: args.payload,
    run,
    status: args.status,
    signal: args.signal,
  });

  if (run?.prompt) {
    await args.saveRunSummary(args.runId, run.prompt, output ?? "");
    args.signal.throwIfAborted();
  }

  L.debug("Teams org callback processed successfully", { runId: args.runId });
  return successResponse();
}

interface HandleTeamsOrgInternalCallbackInput {
  readonly db: Db;
  readonly callback: InternalRunCallbackEnvelope;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly formatRunError: (params: {
    readonly runId: string;
    readonly chatThreadId: string | null | undefined;
    readonly errorMessage: string;
  }) => Promise<string>;
  readonly saveRunSummary: (
    runId: string,
    prompt: string,
    resultText: string,
  ) => Promise<void>;
  readonly signal?: AbortSignal;
}

async function handleTeamsOrgInternalCallback(
  input: HandleTeamsOrgInternalCallbackInput,
): Promise<TeamsOrgCallbackResult> {
  const { callback } = input;
  const signal = input.signal ?? new AbortController().signal;
  const payload = parsePayload(callback.payload);
  if (!payload) {
    return errorResponse(400, "Invalid or missing payload");
  }

  L.debug("Processing org Teams callback", {
    runId: callback.runId,
    status: callback.status,
    conversationId: payload.conversationId,
  });

  if (callback.status === "progress") {
    return await handleProgress({
      payload,
      signal,
    });
  }
  if (payload.canonicalChatDelivery) {
    return await handleCanonicalChatCompletion({
      db: input.db,
      runId: callback.runId,
      status: callback.status,
      payload,
      signal,
    });
  }

  return await handleCompletion({
    db: input.db,
    runId: callback.runId,
    status: callback.status,
    error: callback.error,
    payload,
    getFeatureOverrides: input.getFeatureOverrides,
    formatRunError: input.formatRunError,
    saveRunSummary: input.saveRunSummary,
    signal,
  });
}

export const handleTeamsOrgInternalCallback$ = command(
  async (
    { get, set },
    callback: InternalRunCallbackEnvelope,
    signal: AbortSignal,
  ): Promise<TeamsOrgInternalCallbackResult> => {
    const result = await handleTeamsOrgInternalCallback({
      db: set(writeDb$),
      callback,
      getFeatureOverrides: (orgId, userId) => {
        return get(userFeatureSwitchOverrides(orgId, userId));
      },
      formatRunError: (params) => {
        return set(formatRunErrorForRunOwner$, params, signal);
      },
      saveRunSummary: (runId, prompt, resultText) => {
        return set(
          saveRunSummary$,
          {
            runId,
            triggerSource: "teams",
            prompt,
            resultText,
          },
          signal,
        );
      },
      signal,
    });
    return dispatchResultFromResponse(result);
  },
);

export async function handleTeamsOrgInternalCallbackWithoutCcstate(
  db: Db,
  callback: InternalRunCallbackEnvelope,
  signal?: AbortSignal,
): Promise<InternalRunCallbackDispatchResult> {
  const result = await handleTeamsOrgInternalCallback({
    db,
    callback,
    getFeatureOverrides: async (orgId, userId) => {
      return (
        (await loadUserFeatureSwitchContext(db, orgId, userId)).overrides ?? {}
      );
    },
    formatRunError: (params) => {
      return Promise.resolve(
        formatRunErrorForExternalSurface({
          code: "INTERNAL_SERVER_ERROR",
          message: params.errorMessage,
        }),
      );
    },
    saveRunSummary: async (runId, prompt, resultText) => {
      await saveRunSummary(
        db,
        {
          runId,
          triggerSource: "teams",
          prompt,
          resultText,
        },
        signal,
      );
    },
    signal,
  });
  return dispatchResultFromResponse(result);
}
