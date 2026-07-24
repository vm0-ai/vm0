import { command } from "ccstate";
import { formatRunErrorForExternalSurface } from "@vm0/api-contracts/contracts/errors";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgThreadSessions } from "@vm0/db/schema/slack-org-thread-session";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, countDistinct, eq } from "drizzle-orm";

import { buildAgentResponseMessage } from "../../lib/slack-blocks";
import { logger } from "../../lib/log";
import { nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import {
  createSlackClient,
  postMessage,
  setThreadStatus,
} from "../external/slack-message-client";
import { decryptPersistentSecretValue } from "./crypto.utils";
import {
  loadUserFeatureSwitchContext,
  userFeatureSwitchOverrides,
} from "./feature-switches.service";
import { getRunOutputText } from "./run-output.service";
import { saveRunSummary, saveRunSummary$ } from "./run-summary.service";
import { formatRunErrorForRunOwner$ } from "./run-error-format.service";
import { resolveIntegrationAgentResponsePresentation } from "./integration-agent-response-presentation.service";
import type { InternalRunCallbackEnvelope } from "./internal-run-callback";
import { waitUntil } from "../context/wait-until";
import { tapError } from "../utils";
import {
  slackOrgCallbackPayloadSchema,
  type SlackOrgCallbackPayload,
} from "./slack-org-callback-payload";

const L = logger("InternalCallbacksSlackOrg");
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

type SlackOrgInternalCallbackResult =
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

function parsePayload(payload: unknown): SlackOrgCallbackPayload | null {
  const result = slackOrgCallbackPayloadSchema.safeParse(payload);
  return result.success ? result.data : null;
}

function dispatchResultFromResponse(
  result: SlackOrgCallbackResult,
): SlackOrgInternalCallbackResult {
  if (result.status === 200) {
    return { success: true };
  }
  return {
    success: false,
    status: result.status,
    error: result.body.error,
  };
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
      count: countDistinct(slackOrgThreadSessions.connectionId),
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

async function resolveLegacySlackAgentResponsePresentation(args: {
  readonly db: Db;
  readonly runId: string;
  readonly run: RunContext | undefined;
  readonly payload: SlackOrgCallbackPayload;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly signal: AbortSignal;
}) {
  if (!args.run) {
    return { logsUrl: undefined, footerText: undefined };
  }
  const mentionerCount = await countThreadMentioners({
    db: args.db,
    workspaceId: args.payload.workspaceId,
    channelId: args.payload.channelId,
    threadTs: args.payload.threadTs,
  });
  const replyToMention =
    mentionerCount > 1
      ? await resolveReplyToMention(args.db, args.payload.connectionId)
      : undefined;
  return await resolveIntegrationAgentResponsePresentation({
    db: args.db,
    orgId: args.run.orgId,
    userId: args.run.userId,
    runId: args.runId,
    agentId: args.payload.agentId,
    replyToMention,
    getFeatureOverrides: args.getFeatureOverrides,
    signal: args.signal,
  });
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
  await saveOrgThreadSession({
    db: args.db,
    payload: args.payload,
    run,
    status: args.status,
    signal: args.signal,
  });

  const presentation = await resolveLegacySlackAgentResponsePresentation({
    db: args.db,
    runId: args.runId,
    run,
    payload: args.payload,
    getFeatureOverrides: args.getFeatureOverrides,
    signal: args.signal,
  });
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
      blocks: buildAgentResponseMessage(
        responseText,
        presentation.logsUrl,
        presentation.footerText,
      ),
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

interface HandleSlackOrgInternalCallbackInput {
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

async function handleSlackOrgInternalCallback(
  input: HandleSlackOrgInternalCallbackInput,
): Promise<SlackOrgCallbackResult> {
  const { callback } = input;
  const signal = input.signal ?? new AbortController().signal;
  const payload = parsePayload(callback.payload);
  if (!payload) {
    return errorResponse(400, "Invalid or missing payload");
  }

  L.debug("Processing org Slack callback", {
    runId: callback.runId,
    status: callback.status,
    channelId: payload.channelId,
  });

  if (callback.status === "progress") {
    return await handleProgress({
      db: input.db,
      runId: callback.runId,
      payload,
      getFeatureOverrides: input.getFeatureOverrides,
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

export async function handleSlackOrgInternalCallbackWithoutCcstate(
  db: Db,
  callback: InternalRunCallbackEnvelope,
  signal?: AbortSignal,
): Promise<SlackOrgInternalCallbackResult> {
  const result = await handleSlackOrgInternalCallback({
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
          triggerSource: "slack",
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

export const handleSlackOrgInternalCallback$ = command(
  async (
    { get, set },
    callback: InternalRunCallbackEnvelope,
    signal: AbortSignal,
  ): Promise<SlackOrgInternalCallbackResult> => {
    const result = await handleSlackOrgInternalCallback({
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
            triggerSource: "slack",
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
