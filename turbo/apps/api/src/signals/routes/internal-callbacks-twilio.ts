import { command } from "ccstate";
import {
  internalCallbacksTwilioContract,
  twilioCallbackPayloadSchema,
  type TwilioCallbackPayload,
} from "@vm0/api-contracts/contracts/internal-callbacks-twilio";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { whatsappUserLinks } from "@vm0/db/schema/whatsapp-user-link";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq } from "drizzle-orm";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import { logger } from "../../lib/log";
import {
  isTwilioApiError,
  sendTwilioWhatsAppMessage,
  sendTwilioWhatsAppTypingIndicator,
} from "../external/twilio-client";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { getRunOutputText } from "../services/run-output.service";
import {
  formatAgentPhoneAuditLink,
  resolveAgentPhoneAuditLogsUrl,
  resolveAgentPhoneReplyFooterText,
} from "../services/zero-agentphone.service";
import { formatRunErrorLikeWebMessage } from "../services/zero-chat-thread.service";
import {
  getTwilioWhatsAppConfig,
  markdownToWhatsAppPlain,
  normalizeWhatsAppHandle,
  saveWhatsAppThreadSession,
  splitWhatsAppMessageBody,
  storeOutboundWhatsAppMessage,
} from "../services/zero-whatsapp.service";
import { settle } from "../utils";

const log = logger("api:callback:twilio");

interface RunContext {
  readonly userId: string;
  readonly orgId: string;
  readonly sessionId: string;
  readonly lastEventSequence: number | null;
  readonly chatThreadId: string | null;
}

interface FormatRunErrorParams {
  readonly runId: string;
  readonly chatThreadId: string | null | undefined;
  readonly errorMessage: string;
}

type FormatRunError = (params: FormatRunErrorParams) => Promise<string>;
type GetFeatureOverrides = (
  orgId: string,
  userId: string,
) => Promise<Record<string, boolean>>;

type TwilioCallbackCompletionResponse =
  | { readonly status: 200; readonly body: { readonly success: true } }
  | { readonly status: 502; readonly body: { readonly error: string } };

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

function parsePayload(payload: unknown): TwilioCallbackPayload | null {
  const result = twilioCallbackPayloadSchema.safeParse(payload);
  return result.success ? result.data : null;
}

async function refreshTypingIfSupported(args: {
  readonly payload: TwilioCallbackPayload;
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const config = getTwilioWhatsAppConfig();
  if (!config.configured || !config.accountSid || !config.authToken) {
    return;
  }

  const result = await settle(
    sendTwilioWhatsAppTypingIndicator(
      {
        accountSid: config.accountSid,
        authToken: config.authToken,
        messageSid: args.payload.messageSid,
      },
      args.signal,
    ),
  );
  if (!result.ok) {
    log.debug("Failed to refresh WhatsApp typing indicator", {
      runId: args.runId,
      messageSid: args.payload.messageSid,
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
      chatThreadId: zeroRuns.chatThreadId,
    })
    .from(agentRuns)
    .leftJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
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
  readonly formatRunError: FormatRunError;
  readonly signal: AbortSignal;
}): Promise<string> {
  if (args.status === "failed") {
    return await args.formatRunError({
      runId: args.runId,
      chatThreadId: args.run?.chatThreadId,
      errorMessage:
        args.error ?? "The agent encountered an error during execution.",
    });
  }

  const output = await getRunOutputText(args.runId, {
    waitForOutput: false,
    knownLastEventSequence: args.run?.lastEventSequence,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  return output ?? "Task completed successfully.";
}

function buildWhatsAppCompletionText(args: {
  readonly mainText: string;
  readonly logsUrl: string | undefined;
  readonly footerText: string | undefined;
}): string {
  return [
    markdownToWhatsAppPlain(args.mainText),
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
  readonly payload: TwilioCallbackPayload;
}): Promise<boolean> {
  const [currentUserLink] = await args.db
    .select({
      id: whatsappUserLinks.id,
      phoneHandle: whatsappUserLinks.phoneHandle,
    })
    .from(whatsappUserLinks)
    .where(eq(whatsappUserLinks.id, args.payload.userLinkId))
    .limit(1);

  return (
    !currentUserLink ||
    currentUserLink.phoneHandle !==
      normalizeWhatsAppHandle(args.payload.phoneHandle)
  );
}

async function sendWhatsAppCompletionMessages(args: {
  readonly payload: TwilioCallbackPayload;
  readonly body: string;
  readonly signal: AbortSignal;
}): Promise<
  | {
      readonly ok: true;
      readonly sent: readonly Awaited<
        ReturnType<typeof sendTwilioWhatsAppMessage>
      >[];
    }
  | {
      readonly ok: false;
      readonly response: TwilioCallbackCompletionResponse;
    }
> {
  const config = getTwilioWhatsAppConfig();
  if (
    !config.configured ||
    !config.accountSid ||
    !config.authToken ||
    !config.fromNumber
  ) {
    return {
      ok: false,
      response: { status: 502, body: { error: "Twilio is not configured" } },
    };
  }

  const sent = [];
  for (const chunk of splitWhatsAppMessageBody(args.body)) {
    const sendResult = await settle(
      sendTwilioWhatsAppMessage(
        {
          accountSid: config.accountSid,
          authToken: config.authToken,
          fromNumber: config.fromNumber,
          toNumber: args.payload.phoneHandle,
          body: chunk,
        },
        args.signal,
      ),
    );
    if (!sendResult.ok) {
      if (isTwilioApiError(sendResult.error)) {
        return {
          ok: false,
          response: {
            status: 502 as const,
            body: {
              error: `Twilio API error: ${
                sendResult.error.body || `HTTP ${sendResult.error.status}`
              }`,
            },
          },
        };
      }
      throw sendResult.error;
    }
    sent.push(sendResult.value);
  }

  return { ok: true, sent };
}

async function recordWhatsAppCompletion(args: {
  readonly db: Db;
  readonly payload: TwilioCallbackPayload;
  readonly run: RunContext | undefined;
  readonly status: "completed" | "failed";
  readonly sent: readonly Awaited<
    ReturnType<typeof sendTwilioWhatsAppMessage>
  >[];
  readonly signal: AbortSignal;
}): Promise<void> {
  for (const sent of args.sent) {
    await storeOutboundWhatsAppMessage(args.db, {
      twilioMessageSid: sent.sid,
      userLinkId: args.payload.userLinkId,
      phoneHandle: args.payload.phoneHandle,
      fromNumber: sent.fromNumber ?? args.payload.toNumber,
      toNumber: sent.toNumber ?? args.payload.phoneHandle,
      body: sent.body ?? undefined,
    });
    args.signal.throwIfAborted();
  }

  if (!args.run) {
    return;
  }

  await saveWhatsAppThreadSession(args.db, {
    userLinkId: args.payload.userLinkId,
    rootMessageId: args.payload.rootMessageId,
    existingSessionId: args.payload.existingSessionId ?? undefined,
    newSessionId: args.payload.existingSessionId
      ? undefined
      : args.run.sessionId,
    messageSid: args.payload.messageSid,
    runStatus: args.status,
  });
  args.signal.throwIfAborted();
}

async function handleCompletion(args: {
  readonly db: Db;
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly error: string | undefined;
  readonly payload: TwilioCallbackPayload;
  readonly getFeatureOverrides: GetFeatureOverrides;
  readonly formatRunError: FormatRunError;
  readonly signal: AbortSignal;
}): Promise<TwilioCallbackCompletionResponse> {
  if (await staleLinkDisconnected({ db: args.db, payload: args.payload })) {
    log.debug("Skipping stale Twilio callback for disconnected WhatsApp link", {
      runId: args.runId,
      userLinkId: args.payload.userLinkId,
    });
    return successResponse();
  }
  args.signal.throwIfAborted();

  const run = await loadRunContext({
    db: args.db,
    runId: args.runId,
    signal: args.signal,
  });

  if (args.status === "failed") {
    log.error("WhatsApp agent run failed", {
      runId: args.runId,
      error: args.error,
    });
  }

  const mainText = await resolveCompletionText({
    runId: args.runId,
    status: args.status,
    error: args.error,
    run,
    formatRunError: args.formatRunError,
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
        composeId: args.payload.agentId,
      })
    : undefined;
  args.signal.throwIfAborted();

  const body = buildWhatsAppCompletionText({
    mainText,
    logsUrl,
    footerText,
  });

  const sendResult = await sendWhatsAppCompletionMessages({
    payload: args.payload,
    body,
    signal: args.signal,
  });
  if (!sendResult.ok) {
    return sendResult.response;
  }
  args.signal.throwIfAborted();

  await recordWhatsAppCompletion({
    db: args.db,
    payload: args.payload,
    run,
    status: args.status,
    sent: sendResult.sent,
    signal: args.signal,
  });

  return successResponse();
}

const handleTwilioCallback$ = command(
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
      formatRunError: (params) => {
        return get(formatRunErrorLikeWebMessage(params));
      },
      signal,
    });
    signal.throwIfAborted();

    if (result.status === 200) {
      log.debug("Twilio callback processed successfully", {
        runId: callback.runId,
      });
    }
    return result;
  },
);

export const internalCallbacksTwilioRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksTwilioContract.post,
    handler: callbackRoute(handleTwilioCallback$),
  },
];
