import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import {
  internalCallbacksTelegramContract,
  telegramCallbackPayloadSchema,
  type TelegramCallbackPayload,
} from "@vm0/api-contracts/contracts/internal-callbacks-telegram";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { eq } from "drizzle-orm";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import {
  buildTelegramErrorResponse,
  buildTelegramResponse,
  splitMessage,
} from "../../lib/telegram-format";
import type { RouteEntry } from "../route";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import {
  deleteMessage,
  sendChatAction,
  sendMessage,
  type SendTelegramMessageResult,
} from "../external/telegram-client";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../external/telegram-official";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { getRunOutputText } from "../services/run-output.service";
import {
  saveTelegramThreadSession,
  storeTelegramBotMessage,
} from "../services/zero-telegram-callback-persistence.service";
import { telegramBotToken } from "../services/zero-telegram-data.service";
import { resolveTelegramAgentReplyFooterText } from "../services/zero-telegram-footer.service";
import { safeAsync } from "../utils";

const L = logger("InternalCallbacksTelegram");

interface RunContext {
  readonly userId: string;
  readonly orgId: string;
  readonly sessionId: string;
  readonly lastEventSequence: number | null;
}

type TelegramCallbackResult =
  | { readonly status: 200; readonly body: { readonly success: true } }
  | { readonly status: 400 | 502; readonly body: { readonly error: string } };

function successResponse(): {
  readonly status: 200;
  readonly body: { readonly success: true };
} {
  return { status: 200, body: { success: true } };
}

function errorResponse(
  status: 400 | 500 | 502,
  message: string,
): {
  readonly status: 400 | 500 | 502;
  readonly body: { readonly error: string };
} {
  return { status, body: { error: message } };
}

function parsePayload(payload: unknown): TelegramCallbackPayload | null {
  const result = telegramCallbackPayloadSchema.safeParse(payload);
  return result.success ? result.data : null;
}

function agentDisplayLabel(row: {
  readonly displayName: string | null;
  readonly name: string | null;
}): string {
  return row.displayName?.trim() || row.name?.trim() || "zero";
}

async function resolveAgentInfo(args: {
  readonly db: Db;
  readonly agentId: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly label: string; readonly name: string }> {
  const [agentRow] = await args.db
    .select({ displayName: zeroAgents.displayName, name: zeroAgents.name })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, args.agentId))
    .limit(1);
  args.signal.throwIfAborted();

  const label = agentRow ? agentDisplayLabel(agentRow) : "zero";
  return {
    label,
    name: agentRow?.name ?? label,
  };
}

async function resolveTelegramAuditLogsUrl(args: {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  const overrides = await args.getFeatureOverrides(args.orgId, args.userId);
  args.signal.throwIfAborted();
  const typedOverrides =
    Object.keys(overrides).length > 0
      ? (overrides as Partial<Record<FeatureSwitchKey, boolean>>)
      : undefined;
  const enabled = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
    userId: args.userId,
    orgId: args.orgId,
    overrides: typedOverrides,
  });
  if (!enabled) {
    return undefined;
  }

  return `${env("VM0_WEB_URL")}/activities/${encodeURIComponent(args.runId)}`;
}

async function deleteThinkingMessageIfPresent(args: {
  readonly botToken: string;
  readonly chatId: string;
  readonly thinkingMessageId: string | null | undefined;
}): Promise<void> {
  if (!args.thinkingMessageId) {
    return;
  }

  const result = await safeAsync(() => {
    return deleteMessage(
      args.botToken,
      args.chatId,
      Number(args.thinkingMessageId),
    );
  });
  if ("error" in result) {
    L.debug("Failed to delete legacy thinking placeholder", {
      thinkingMessageId: args.thinkingMessageId,
      error: result.error,
    });
  }
}

function buildCompletionOutput(args: {
  readonly status: "completed" | "failed";
  readonly output: string | undefined;
  readonly error: string | undefined;
  readonly logsUrl: string | undefined;
  readonly footerText: string | undefined;
}): { readonly htmlOutput: string; readonly responseText: string | undefined } {
  if (args.status === "completed") {
    const responseText = args.output ?? "Task completed successfully.";
    return {
      responseText,
      htmlOutput: buildTelegramResponse(
        responseText,
        args.logsUrl,
        args.footerText,
      ),
    };
  }

  const errorDetail =
    args.error ?? "The agent encountered an error during execution.";
  return {
    responseText: undefined,
    htmlOutput: buildTelegramErrorResponse(
      errorDetail,
      args.logsUrl,
      args.footerText,
    ),
  };
}

function telegramErrorResponse(
  result: Extract<SendTelegramMessageResult, { kind: "telegram-error" }>,
): {
  readonly status: 400 | 502;
  readonly body: { readonly error: string };
} {
  return {
    status: result.status >= 500 ? 502 : 400,
    body: {
      error: `Telegram API error: ${
        result.description ?? `HTTP ${result.status}`
      }`,
    },
  };
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

async function resolveCompletionDecorations(args: {
  readonly db: Db;
  readonly runId: string;
  readonly run: RunContext | undefined;
  readonly installationId: string;
  readonly agentId: string;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly signal: AbortSignal;
}): Promise<{
  readonly logsUrl: string | undefined;
  readonly footerText: string | undefined;
}> {
  if (!args.run) {
    return { logsUrl: undefined, footerText: undefined };
  }

  const logsUrl = await resolveTelegramAuditLogsUrl({
    runId: args.runId,
    orgId: args.run.orgId,
    userId: args.run.userId,
    getFeatureOverrides: args.getFeatureOverrides,
    signal: args.signal,
  });
  const footerText = await resolveTelegramAgentReplyFooterText({
    db: args.db,
    orgId: args.run.orgId,
    runId: args.runId,
    installationId: args.installationId,
    agentId: args.agentId,
  });
  args.signal.throwIfAborted();

  return { logsUrl, footerText };
}

async function sendCompletionMessages(args: {
  readonly botToken: string;
  readonly chatId: string;
  readonly htmlOutput: string;
  readonly replyToMessageId: number | undefined;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly kind: "ok"; readonly firstMessageId: number | undefined }
  | Extract<SendTelegramMessageResult, { kind: "telegram-error" }>
> {
  let firstMessageId: number | undefined;
  for (const chunk of splitMessage(args.htmlOutput)) {
    const sent = await sendMessage(args.botToken, args.chatId, chunk, {
      replyToMessageId: args.replyToMessageId,
    });
    args.signal.throwIfAborted();
    if (sent.kind === "telegram-error") {
      return sent;
    }
    if (firstMessageId === undefined) {
      firstMessageId = sent.messageId;
    }
  }

  return { kind: "ok", firstMessageId };
}

async function persistCompletionResult(args: {
  readonly db: Db;
  readonly run: RunContext | undefined;
  readonly isOfficial: boolean;
  readonly payload: TelegramCallbackPayload;
  readonly botReplyMessageId: number | undefined;
  readonly responseText: string | undefined;
  readonly status: "completed" | "failed";
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.botReplyMessageId === undefined) {
    return;
  }

  await storeTelegramBotMessage({
    db: args.db,
    scope:
      args.isOfficial && args.run
        ? {
            kind: "official",
            orgId: args.run.orgId,
            userLinkId: args.payload.userLinkId,
          }
        : { kind: "custom", installationId: args.payload.installationId },
    chatId: args.payload.chatId,
    messageId: args.botReplyMessageId,
    text: args.responseText,
  });
  args.signal.throwIfAborted();

  if (!args.run) {
    return;
  }

  await saveTelegramThreadSession({
    db: args.db,
    userLinkId: args.payload.userLinkId,
    userLinkKind: args.isOfficial ? "official" : "custom",
    chatId: args.payload.chatId,
    rootMessageId: args.payload.isDM ? "dm" : String(args.botReplyMessageId),
    previousRootMessageId: args.payload.rootMessageId ?? undefined,
    existingSessionId: args.payload.existingSessionId ?? undefined,
    newSessionId: args.payload.existingSessionId
      ? undefined
      : args.run.sessionId,
    messageId: args.payload.messageId,
    runStatus: args.status,
  });
  args.signal.throwIfAborted();
}

async function handleCompletion(args: {
  readonly db: Db;
  readonly botToken: string;
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly error: string | undefined;
  readonly payload: TelegramCallbackPayload;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly signal: AbortSignal;
}): Promise<TelegramCallbackResult> {
  const {
    installationId,
    chatId,
    messageId,
    agentId,
    isDM,
    thinkingMessageId,
  } = args.payload;

  const agent = await resolveAgentInfo({
    db: args.db,
    agentId,
    signal: args.signal,
  });
  const isOfficial = isOfficialTelegramBotId(installationId);

  await deleteThinkingMessageIfPresent({
    botToken: args.botToken,
    chatId,
    thinkingMessageId,
  });
  args.signal.throwIfAborted();

  await sendChatAction(args.botToken, chatId, "typing");
  args.signal.throwIfAborted();

  const run = await loadRunContext({
    db: args.db,
    runId: args.runId,
    signal: args.signal,
  });

  if (args.status === "failed") {
    L.error("Agent run failed", {
      runId: args.runId,
      agentName: agent.name,
      chatId,
      error: args.error,
    });
  }

  const output = await resolveCompletionText({
    runId: args.runId,
    status: args.status,
    run,
    signal: args.signal,
  });
  const { logsUrl, footerText } = await resolveCompletionDecorations({
    db: args.db,
    runId: args.runId,
    run,
    installationId,
    agentId,
    getFeatureOverrides: args.getFeatureOverrides,
    signal: args.signal,
  });
  const { htmlOutput, responseText } = buildCompletionOutput({
    status: args.status,
    output,
    error: args.error,
    logsUrl,
    footerText,
  });

  const sendResult = await sendCompletionMessages({
    botToken: args.botToken,
    chatId,
    htmlOutput,
    replyToMessageId: isDM ? undefined : Number(messageId),
    signal: args.signal,
  });
  if (sendResult.kind === "telegram-error") {
    return telegramErrorResponse(sendResult);
  }

  await persistCompletionResult({
    db: args.db,
    run,
    isOfficial,
    payload: args.payload,
    botReplyMessageId: sendResult.firstMessageId,
    responseText,
    status: args.status,
    signal: args.signal,
  });

  return successResponse();
}

const handleTelegramCallback$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const callback = get(callbackPayload$);
    const payload = parsePayload(callback.payload);
    if (!payload) {
      return errorResponse(400, "Invalid or missing payload");
    }

    L.debug("Processing Telegram callback", {
      runId: callback.runId,
      status: callback.status,
      chatId: payload.chatId,
    });

    const botToken = isOfficialTelegramBotId(payload.installationId)
      ? getOfficialTelegramBotConfig().botToken
      : (await get(telegramBotToken({ botId: payload.installationId })))
          ?.botToken;
    signal.throwIfAborted();

    if (!botToken) {
      L.warn("Telegram bot token not configured", {
        installationId: payload.installationId,
      });
      return successResponse();
    }

    if (callback.status === "progress") {
      const typing = await safeAsync(() => {
        return sendChatAction(botToken, payload.chatId, "typing");
      });
      signal.throwIfAborted();
      if ("error" in typing) {
        L.debug("Failed to refresh typing indicator", {
          runId: callback.runId,
          error: typing.error,
        });
      }
      return successResponse();
    }

    const db = set(writeDb$);
    const result = await handleCompletion({
      db,
      botToken,
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
      L.debug("Telegram callback processed successfully", {
        runId: callback.runId,
      });
    }
    return result;
  },
);

export const internalCallbacksTelegramRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksTelegramContract.post,
    handler: callbackRoute(handleTelegramCallback$),
  },
];
