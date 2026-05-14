import { command } from "ccstate";
import {
  agentPhoneCallbackPayloadSchema,
  internalCallbacksAgentPhoneContract,
  type AgentPhoneCallbackPayload,
} from "@vm0/api-contracts/contracts/internal-callbacks-agentphone";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { eq } from "drizzle-orm";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import { logger } from "../../lib/log";
import {
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
  sendAgentPhoneTypingIndicator,
} from "../external/agentphone-client";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { getRunOutputText } from "../services/run-output.service";
import {
  formatAgentPhoneAuditLink,
  isAgentPhoneChannel,
  markdownToImessagePlain,
  resolveAgentPhoneAuditLogsUrl,
  resolveAgentPhoneReplyFooterText,
  resolveAgentPhoneUserLink,
  saveAgentPhoneThreadSession,
  storeOutboundAgentPhoneMessage,
  type AgentPhoneChannel,
} from "../services/zero-agentphone.service";
import { safeAsync } from "../utils";

const log = logger("api:callback:agentphone");

interface RunContext {
  readonly userId: string;
  readonly orgId: string;
  readonly sessionId: string;
  readonly lastEventSequence: number | null;
}

function successResponse(): {
  readonly status: 200;
  readonly body: { readonly success: true };
} {
  return { status: 200, body: { success: true } };
}

function errorResponse(
  status: 400 | 502,
  message: string,
): {
  readonly status: 400 | 502;
  readonly body: { readonly error: string };
} {
  return { status, body: { error: message } };
}

function parsePayload(payload: unknown): AgentPhoneCallbackPayload | null {
  const result = agentPhoneCallbackPayloadSchema.safeParse(payload);
  return result.success ? result.data : null;
}

async function refreshTypingIfSupported(args: {
  readonly payload: AgentPhoneCallbackPayload;
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.payload.channel !== "imessage" || !args.payload.conversationId) {
    return;
  }
  const conversationId = args.payload.conversationId;

  const result = await safeAsync(() => {
    return sendAgentPhoneTypingIndicator({ conversationId }, args.signal);
  });
  if ("error" in result) {
    log.debug("Failed to refresh AgentPhone typing indicator", {
      runId: args.runId,
      error: result.error,
    });
  }
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
      sessionId: agentRuns.sessionId,
      lastEventSequence: agentRuns.lastEventSequence,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  args.signal.throwIfAborted();
  return run;
}

async function resolveCompletionText(args: {
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly error: string | undefined;
  readonly run: RunContext | undefined;
  readonly signal: AbortSignal;
}): Promise<string> {
  if (args.status === "failed") {
    return args.error ?? "The agent encountered an error during execution.";
  }

  const output = await getRunOutputText(args.runId, {
    waitForOutput: false,
    knownLastEventSequence: args.run?.lastEventSequence,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  return output ?? "Task completed successfully.";
}

function buildAgentPhoneCompletionText(args: {
  readonly mainText: string;
  readonly logsUrl: string | undefined;
  readonly footerText: string | undefined;
}): string {
  return [
    markdownToImessagePlain(args.mainText),
    args.logsUrl ? formatAgentPhoneAuditLink(args.logsUrl) : null,
    args.footerText,
  ]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

async function staleLinkDisconnected(args: {
  readonly db: Db;
  readonly payload: AgentPhoneCallbackPayload;
  readonly channel: AgentPhoneChannel;
}): Promise<boolean> {
  const currentUserLink = await resolveAgentPhoneUserLink(
    args.db,
    args.payload.phoneHandle,
    args.channel,
  );
  return currentUserLink?.id !== args.payload.userLinkId;
}

async function handleCompletion(args: {
  readonly db: Db;
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly error: string | undefined;
  readonly payload: AgentPhoneCallbackPayload;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly status: 200; readonly body: { readonly success: true } }
  | { readonly status: 502; readonly body: { readonly error: string } }
> {
  const payloadChannel = args.payload.channel ?? "";
  const userChannel: AgentPhoneChannel = isAgentPhoneChannel(payloadChannel)
    ? payloadChannel
    : "sms";

  if (
    await staleLinkDisconnected({
      db: args.db,
      payload: args.payload,
      channel: userChannel,
    })
  ) {
    log.debug(
      "Skipping stale AgentPhone callback for disconnected phone link",
      {
        runId: args.runId,
        userLinkId: args.payload.userLinkId,
      },
    );
    return successResponse();
  }
  args.signal.throwIfAborted();

  const run = await loadRunContext({
    db: args.db,
    runId: args.runId,
    signal: args.signal,
  });

  if (args.status === "failed") {
    log.error("AgentPhone agent run failed", {
      runId: args.runId,
      error: args.error,
    });
  }

  const mainText = await resolveCompletionText({
    runId: args.runId,
    status: args.status,
    error: args.error,
    run,
    signal: args.signal,
  });
  const logsUrl = run
    ? await resolveAgentPhoneAuditLogsUrl({
        orgId: run.orgId,
        userId: run.userId,
        runId: args.runId,
        getFeatureOverrides: args.getFeatureOverrides,
        signal: args.signal,
      })
    : undefined;
  const footerText = run
    ? await resolveAgentPhoneReplyFooterText({
        db: args.db,
        orgId: run.orgId,
        runId: args.runId,
        agentId: args.payload.agentId,
      })
    : undefined;
  args.signal.throwIfAborted();

  const body = buildAgentPhoneCompletionText({
    mainText,
    logsUrl,
    footerText,
  });

  const sendResult = await safeAsync(() => {
    return sendAgentPhoneMessage(
      {
        agentphoneAgentId: args.payload.agentphoneAgentId,
        toNumber: args.payload.phoneHandle,
        body,
      },
      args.signal,
    );
  });
  if ("error" in sendResult) {
    if (isAgentPhoneApiError(sendResult.error)) {
      return {
        status: 502 as const,
        body: {
          error: `AgentPhone API error: ${
            sendResult.error.body || `HTTP ${sendResult.error.status}`
          }`,
        },
      };
    }
    throw sendResult.error;
  }
  const sent = sendResult.ok;
  args.signal.throwIfAborted();

  await storeOutboundAgentPhoneMessage(args.db, {
    agentphoneMessageId: sent.id,
    conversationId: args.payload.conversationId,
    agentphoneAgentId: args.payload.agentphoneAgentId,
    userLinkId: args.payload.userLinkId,
    phoneHandle: args.payload.phoneHandle,
    fromNumber: sent.fromNumber ?? args.payload.toNumber,
    toNumber: sent.toNumber ?? args.payload.phoneHandle,
    body,
    channel: sent.channel,
    userChannel,
  });
  args.signal.throwIfAborted();

  if (run) {
    await saveAgentPhoneThreadSession(args.db, {
      userLinkId: args.payload.userLinkId,
      conversationId: args.payload.conversationId,
      existingSessionId: args.payload.existingSessionId ?? undefined,
      newSessionId: args.payload.existingSessionId ? undefined : run.sessionId,
      messageId: args.payload.messageId,
      runStatus: args.status,
    });
    args.signal.throwIfAborted();
  }

  return successResponse();
}

const handleAgentPhoneCallback$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const callback = get(callbackPayload$);
    const payload = parsePayload(callback.payload);
    if (!payload) {
      return errorResponse(400, "Invalid or missing payload");
    }

    if (callback.status === "progress") {
      await refreshTypingIfSupported({
        payload,
        runId: callback.runId,
        signal,
      });
      signal.throwIfAborted();
      return successResponse();
    }

    const db = set(writeDb$);
    const result = await handleCompletion({
      db,
      runId: callback.runId,
      status: callback.status,
      error: callback.error,
      payload,
      getFeatureOverrides: (orgId, userId) => {
        return get(userFeatureSwitchOverrides(orgId, userId));
      },
      signal,
    });
    signal.throwIfAborted();

    if (result.status === 200) {
      log.debug("AgentPhone callback processed successfully", {
        runId: callback.runId,
      });
    }
    return result;
  },
);

export const internalCallbacksAgentPhoneRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksAgentPhoneContract.post,
    handler: callbackRoute(handleAgentPhoneCallback$),
  },
];
