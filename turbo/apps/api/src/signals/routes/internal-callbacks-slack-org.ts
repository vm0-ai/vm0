import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import {
  getFrameworkForType,
  modelProviderTypeSchema,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  internalCallbacksSlackOrgContract,
  slackOrgCallbackPayloadSchema,
  type SlackOrgCallbackPayload,
} from "@vm0/api-contracts/contracts/internal-callbacks-slack-org";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgThreadSessions } from "@vm0/db/schema/slack-org-thread-session";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, sql } from "drizzle-orm";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import { buildAgentResponseMessage } from "../../lib/slack-blocks";
import type { RouteEntry } from "../route";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import {
  createSlackClient,
  postMessage,
  setThreadStatus,
} from "../external/slack-message-client";
import { decryptPersistentSecretValue } from "../services/crypto.utils";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { getRunOutputText } from "../services/run-output.service";
import { saveRunSummary$ } from "../services/run-summary.service";
import { formatRunErrorLikeWebMessage } from "../services/zero-chat-thread.service";
import { waitUntil } from "../context/wait-until";
import { tapError } from "../utils";

const L = logger("InternalCallbacksSlackOrg");
const ORG_SENTINEL_USER_ID = "__org__";

type TerminalStatus = "completed" | "failed";

interface RunContext {
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly sessionId: string | null;
  readonly lastEventSequence: number | null;
  readonly chatThreadId: string | null;
}

interface SlackInstallation {
  readonly encryptedBotToken: string;
}

type SlackOrgCallbackResult =
  | { readonly status: 200; readonly body: { readonly success: true } }
  | {
      readonly status: 400 | 404 | 502;
      readonly body: { readonly error: string };
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

function parsePayload(payload: unknown): SlackOrgCallbackPayload | null {
  const result = slackOrgCallbackPayloadSchema.safeParse(payload);
  return result.success ? result.data : null;
}

function buildLogsUrl(runId: string): string {
  return `${env("APP_URL")}/activities/${encodeURIComponent(runId)}`;
}

async function loadInstallation(args: {
  readonly db: Db;
  readonly workspaceId: string;
  readonly signal: AbortSignal;
}): Promise<SlackInstallation | undefined> {
  const [installation] = await args.db
    .select({ encryptedBotToken: slackOrgInstallations.encryptedBotToken })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId))
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

async function resolveReplyToMention(
  db: Db,
  connectionId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ slackUserId: slackOrgConnections.slackUserId })
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.id, connectionId))
    .limit(1);
  return row?.slackUserId ? `<@${row.slackUserId}>` : undefined;
}

async function countThreadMentioners(args: {
  readonly db: Db;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadTs: string;
}): Promise<number> {
  const [row] = await args.db
    .select({
      count: sql<number>`count(distinct ${slackOrgThreadSessions.connectionId})::int`,
    })
    .from(slackOrgThreadSessions)
    .innerJoin(
      slackOrgConnections,
      eq(slackOrgThreadSessions.connectionId, slackOrgConnections.id),
    )
    .where(
      and(
        eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
        eq(slackOrgThreadSessions.slackChannelId, args.channelId),
        eq(slackOrgThreadSessions.slackThreadTs, args.threadTs),
      ),
    );
  return row?.count ?? 0;
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

async function resolveFooterText(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly runId: string;
  readonly payload: SlackOrgCallbackPayload;
}): Promise<string | undefined> {
  const [respondedBy, mentionerCount, modelLabel] = await Promise.all([
    resolveRespondedByLabel({
      db: args.db,
      orgId: args.orgId,
      composeId: args.payload.agentId,
    }),
    countThreadMentioners({
      db: args.db,
      workspaceId: args.payload.workspaceId,
      channelId: args.payload.channelId,
      threadTs: args.payload.threadTs,
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
  if (mentionerCount > 1) {
    const replyTo = await resolveReplyToMention(
      args.db,
      args.payload.connectionId,
    );
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
  const enabled = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
    userId: args.run.userId,
    orgId: args.run.orgId,
    overrides: typedOverrides,
  });
  return enabled ? buildLogsUrl(args.runId) : undefined;
}

async function saveOrgThreadSession(args: {
  readonly db: Db;
  readonly payload: SlackOrgCallbackPayload;
  readonly run: RunContext | undefined;
  readonly status: TerminalStatus;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.status === "failed" || !args.run) {
    return;
  }

  const agentSessionId = args.payload.existingSessionId ?? args.run.sessionId;
  if (args.payload.existingSessionId || !agentSessionId) {
    return;
  }

  await args.db
    .insert(slackOrgThreadSessions)
    .values({
      connectionId: args.payload.connectionId,
      slackChannelId: args.payload.channelId,
      slackThreadTs: args.payload.threadTs,
      agentSessionId,
    })
    .onConflictDoUpdate({
      target: [
        slackOrgThreadSessions.connectionId,
        slackOrgThreadSessions.slackChannelId,
        slackOrgThreadSessions.slackThreadTs,
      ],
      set: {
        agentSessionId,
        updatedAt: nowDate(),
      },
    });
  args.signal.throwIfAborted();
}

function buildResponseText(args: {
  readonly status: TerminalStatus;
  readonly errorText: string | undefined;
  readonly output: string | undefined;
}): string {
  if (args.status === "failed") {
    return args.errorText ?? "Agent execution failed.";
  }
  return args.output ?? "Task completed successfully.";
}

function refreshThreadStatus(args: {
  readonly token: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly status: string;
  readonly runId: string;
  readonly failureMessage: string;
}): void {
  const client = createSlackClient(args.token);
  waitUntil(
    tapError(
      setThreadStatus(client, args.channelId, args.threadTs, args.status),
      (error) => {
        L.warn(args.failureMessage, { runId: args.runId, error });
      },
    ),
  );
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

async function handleProgress(args: {
  readonly db: Db;
  readonly runId: string;
  readonly payload: SlackOrgCallbackPayload;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly signal: AbortSignal;
}): Promise<SlackOrgCallbackResult> {
  const run = await loadRunContext({
    db: args.db,
    runId: args.runId,
    signal: args.signal,
  });
  const installation = await loadInstallation({
    db: args.db,
    workspaceId: args.payload.workspaceId,
    signal: args.signal,
  });

  if (installation) {
    const featureSwitchContext = run
      ? ({
          orgId: run.orgId,
          userId: run.userId,
          overrides: await args.getFeatureOverrides(run.orgId, run.userId),
        } satisfies FeatureSwitchContext)
      : {};
    refreshThreadStatus({
      token: await decryptPersistentSecretValue(
        installation.encryptedBotToken,
        featureSwitchContext,
      ),
      channelId: args.payload.channelId,
      threadTs: args.payload.threadTs,
      status: "is thinking...",
      runId: args.runId,
      failureMessage: "Failed to set thinking thread status",
    });
  }

  return successResponse();
}

async function handleCompletion(args: {
  readonly db: Db;
  readonly runId: string;
  readonly status: TerminalStatus;
  readonly error: string | undefined;
  readonly payload: SlackOrgCallbackPayload;
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
}): Promise<SlackOrgCallbackResult> {
  const installation = await loadInstallation({
    db: args.db,
    workspaceId: args.payload.workspaceId,
    signal: args.signal,
  });
  if (!installation) {
    L.error("Slack org installation not found", {
      workspaceId: args.payload.workspaceId,
    });
    return errorResponse(404, "Slack installation not found");
  }

  const run = await loadRunContext({
    db: args.db,
    runId: args.runId,
    signal: args.signal,
  });
  const featureSwitchContext = run
    ? ({
        orgId: run.orgId,
        userId: run.userId,
        overrides: await args.getFeatureOverrides(run.orgId, run.userId),
      } satisfies FeatureSwitchContext)
    : {};
  const botToken = await decryptPersistentSecretValue(
    installation.encryptedBotToken,
    featureSwitchContext,
  );
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

  await saveOrgThreadSession({
    db: args.db,
    payload: args.payload,
    run,
    status: args.status,
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

  const responseText = buildResponseText({
    status: args.status,
    errorText,
    output,
  });
  const client = createSlackClient(botToken);
  const postResult = await postMessage(
    client,
    args.payload.channelId,
    responseText,
    {
      threadTs: args.payload.threadTs,
      blocks: buildAgentResponseMessage(responseText, logsUrl, footerText),
    },
  );
  args.signal.throwIfAborted();
  if (postResult.kind === "slack_error") {
    return errorResponse(400, `Slack API error: ${postResult.error}`);
  }

  if (run?.prompt) {
    await args.saveRunSummary(args.runId, run.prompt, output ?? "");
    args.signal.throwIfAborted();
  }

  refreshThreadStatus({
    token: botToken,
    channelId: args.payload.channelId,
    threadTs: args.payload.threadTs,
    status: "",
    runId: args.runId,
    failureMessage: "Failed to clear thread status",
  });

  L.debug("Slack org callback processed successfully", { runId: args.runId });
  return successResponse();
}

const handleSlackOrgCallback$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const callback = get(callbackPayload$);
    const payload = parsePayload(callback.payload);
    if (!payload) {
      return errorResponse(400, "Invalid or missing payload");
    }

    L.debug("Processing org Slack callback", {
      runId: callback.runId,
      status: callback.status,
      channelId: payload.channelId,
    });

    const db = set(writeDb$);
    if (callback.status === "progress") {
      return await handleProgress({
        db,
        runId: callback.runId,
        payload,
        getFeatureOverrides: (orgId, userId) => {
          return get(userFeatureSwitchOverrides(orgId, userId));
        },
        signal,
      });
    }

    return await handleCompletion({
      db,
      runId: callback.runId,
      status: callback.status,
      error: callback.error,
      payload,
      getFeatureOverrides: (orgId, userId) => {
        return get(userFeatureSwitchOverrides(orgId, userId));
      },
      formatRunError: (params) => {
        return get(formatRunErrorLikeWebMessage(params));
      },
      saveRunSummary: (runId, prompt, resultText) => {
        return set(
          saveRunSummary$,
          {
            runId,
            triggerSource: "slack",
            prompt,
            resultText,
          },
          signal,
        );
      },
      signal,
    });
  },
);

export const internalCallbacksSlackOrgRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksSlackOrgContract.post,
    handler: callbackRoute(handleSlackOrgCallback$),
  },
];
