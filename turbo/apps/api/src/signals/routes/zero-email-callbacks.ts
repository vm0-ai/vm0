import { command } from "ccstate";
import {
  zeroEmailReplyCallbackContract,
  zeroEmailReplyCallbackPayloadSchema,
  zeroEmailTriggerCallbackContract,
  zeroEmailTriggerCallbackPayloadSchema,
  type ZeroEmailReplyCallbackPayload,
  type ZeroEmailTriggerCallbackPayload,
} from "@vm0/api-contracts/contracts/zero-email";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { emailThreadSessions } from "@vm0/db/schema/email-thread-session";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { eq } from "drizzle-orm";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import type { RouteEntry } from "../route";
import { db$, writeDb$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { getRunOutputText } from "../services/run-output.service";
import { saveRunSummary$ } from "../services/run-summary.service";
import {
  buildFromAddress,
  buildReplyToAddress,
  buildUnsubscribeHeaders,
  buildUnsubscribeUrl,
  completedOutputText,
  enqueueEmail$,
  extractAgentSessionId,
  getOrgNameAndSlug,
  getUserEmail,
  isResendConfigured,
  resolveEmailAuditLogsUrl,
} from "../services/zero-email-common.service";

function successResponse(skipped?: true) {
  return {
    status: 200 as const,
    body: { success: true as const, ...(skipped ? { skipped } : {}) },
  };
}

function errorResponse(message: string, status: 400 | 404) {
  return { status, body: { error: message } };
}

function replyPayload(payload: unknown): ZeroEmailReplyCallbackPayload | null {
  const result = zeroEmailReplyCallbackPayloadSchema.safeParse(payload);
  return result.success ? result.data : null;
}

function triggerPayload(
  payload: unknown,
): ZeroEmailTriggerCallbackPayload | null {
  const result = zeroEmailTriggerCallbackPayloadSchema.safeParse(payload);
  return result.success ? result.data : null;
}

function buildReplyThreadingHeaders(
  payload: ZeroEmailReplyCallbackPayload,
  lastEmailMessageId: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const replyToMessageId = payload.inboundMessageId ?? lastEmailMessageId;
  if (replyToMessageId) {
    headers["In-Reply-To"] = replyToMessageId;
  }

  const references: string[] = [];
  if (payload.inboundReferences) {
    references.push(payload.inboundReferences);
  } else if (lastEmailMessageId) {
    references.push(lastEmailMessageId);
  }
  if (payload.inboundMessageId) {
    references.push(payload.inboundMessageId);
  }
  if (references.length > 0) {
    headers.References = references.join(" ");
  }
  return headers;
}

function buildTriggerThreadingHeaders(
  inboundMessageId: string | undefined,
  inboundReferences: string | undefined,
): Record<string, string> {
  if (!inboundMessageId) {
    return {};
  }
  return {
    "In-Reply-To": inboundMessageId,
    References: [inboundReferences, inboundMessageId].filter(Boolean).join(" "),
  };
}

function buildSubject(
  inboundSubject: string | undefined,
  agentName: string,
): string {
  const cleanSubject = inboundSubject?.replace(/^Re:\s*/i, "") ?? agentName;
  return `Re: ${cleanSubject}`;
}

const handleEmailReplyCallback$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const callback = get(callbackPayload$);
    const payload = replyPayload(callback.payload);
    if (!payload) {
      return errorResponse("Invalid or missing payload", 400);
    }
    if (callback.status === "progress") {
      return successResponse();
    }

    const db = get(db$);
    const [session] = await db
      .select()
      .from(emailThreadSessions)
      .where(eq(emailThreadSessions.id, payload.emailThreadSessionId))
      .limit(1);
    signal.throwIfAborted();
    if (!session) {
      return errorResponse("Email thread session not found", 404);
    }

    const [agent] = await db
      .select({ name: zeroAgents.name, orgId: zeroAgents.orgId })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, session.agentId))
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return errorResponse("Agent not found", 404);
    }

    const writeDb = set(writeDb$);
    const clerk = get(clerk$);
    const orgId = session.orgId ?? agent.orgId;
    const org = await getOrgNameAndSlug(writeDb, clerk, orgId);
    signal.throwIfAborted();
    const userEmail = await getUserEmail(writeDb, clerk, session.userId);
    signal.throwIfAborted();
    if (!userEmail) {
      return successResponse(true);
    }

    const logsUrl = await resolveEmailAuditLogsUrl(writeDb, {
      orgId,
      userId: session.userId,
      runId: callback.runId,
    });
    signal.throwIfAborted();
    const [run] = await writeDb
      .select({
        result: agentRuns.result,
        prompt: agentRuns.prompt,
        lastEventSequence: agentRuns.lastEventSequence,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, callback.runId))
      .limit(1);
    signal.throwIfAborted();

    const rawOutput =
      callback.status === "completed"
        ? await getRunOutputText(callback.runId, {
            knownLastEventSequence: run?.lastEventSequence,
            signal,
          })
        : undefined;
    signal.throwIfAborted();
    const output = completedOutputText(
      callback.status,
      rawOutput,
      callback.error,
    );
    const newAgentSessionId = extractAgentSessionId(run?.result);
    const unsubscribeUrl = buildUnsubscribeUrl(session.userId);
    const emailTo =
      payload.replyRecipientTo && payload.replyRecipientTo.length > 0
        ? payload.replyRecipientTo
        : userEmail;
    const emailCc =
      payload.replyRecipientCc && payload.replyRecipientCc.length > 0
        ? payload.replyRecipientCc
        : undefined;

    await set(
      enqueueEmail$,
      {
        from: buildFromAddress(org.slug),
        to: emailTo,
        cc: emailCc,
        subject: `Re: VM0 - Scheduled run for "${agent.name}" completed`,
        template: {
          template: "agent-reply",
          props: { agentName: agent.name, output, logsUrl, unsubscribeUrl },
        },
        replyTo: buildReplyToAddress(session.replyToToken),
        headers: {
          ...buildReplyThreadingHeaders(payload, session.lastEmailMessageId),
          ...buildUnsubscribeHeaders(unsubscribeUrl),
        },
        threadAction: {
          action: "update_thread_session",
          sessionId: session.id,
          ...(newAgentSessionId ? { agentSessionId: newAgentSessionId } : {}),
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (run?.prompt) {
      await set(
        saveRunSummary$,
        {
          runId: callback.runId,
          triggerSource: "email",
          prompt: run.prompt,
          resultText: rawOutput ?? "",
        },
        signal,
      );
      signal.throwIfAborted();
    }

    return successResponse();
  },
);

const handleVerifiedEmailTriggerCallback$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const callback = get(callbackPayload$);
    const payload = triggerPayload(callback.payload);
    if (!payload) {
      return errorResponse("Invalid or missing payload", 400);
    }
    if (callback.status === "progress") {
      return successResponse();
    }

    const writeDb = set(writeDb$);
    const [agent] = await writeDb
      .select({ name: zeroAgents.name, orgId: zeroAgents.orgId })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, payload.agentId))
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return errorResponse("Agent not found", 404);
    }

    const orgId = payload.runtimeOrgId ?? agent.orgId;
    const clerk = get(clerk$);
    const org = await getOrgNameAndSlug(writeDb, clerk, orgId);
    signal.throwIfAborted();
    const logsUrl = await resolveEmailAuditLogsUrl(writeDb, {
      orgId,
      userId: payload.userId,
      runId: callback.runId,
    });
    signal.throwIfAborted();
    const [run] = await writeDb
      .select({
        result: agentRuns.result,
        prompt: agentRuns.prompt,
        lastEventSequence: agentRuns.lastEventSequence,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, callback.runId))
      .limit(1);
    signal.throwIfAborted();

    const rawOutput =
      callback.status === "completed"
        ? await getRunOutputText(callback.runId, {
            knownLastEventSequence: run?.lastEventSequence,
            signal,
          })
        : undefined;
    signal.throwIfAborted();
    const output = completedOutputText(
      callback.status,
      rawOutput,
      callback.error,
    );
    const agentSessionId = extractAgentSessionId(run?.result);
    const unsubscribeUrl = buildUnsubscribeUrl(payload.userId);
    const emailTo =
      payload.replyRecipientTo && payload.replyRecipientTo.length > 0
        ? payload.replyRecipientTo
        : payload.senderEmail;
    const emailCc =
      payload.replyRecipientCc && payload.replyRecipientCc.length > 0
        ? payload.replyRecipientCc
        : undefined;

    await set(
      enqueueEmail$,
      {
        from: buildFromAddress(org.slug),
        to: emailTo,
        cc: emailCc,
        subject: buildSubject(payload.subject, agent.name),
        template: {
          template: "agent-reply",
          props: { agentName: agent.name, output, logsUrl, unsubscribeUrl },
        },
        replyTo: agentSessionId
          ? buildReplyToAddress(payload.replyToken)
          : undefined,
        headers: {
          ...buildTriggerThreadingHeaders(
            payload.inboundMessageId,
            payload.inboundReferences,
          ),
          ...buildUnsubscribeHeaders(unsubscribeUrl),
        },
        threadAction: agentSessionId
          ? {
              action: "save_thread_session",
              userId: payload.userId,
              agentId: payload.agentId,
              agentSessionId,
              replyToToken: payload.replyToken,
              orgId: payload.runtimeOrgId,
            }
          : undefined,
      },
      signal,
    );
    signal.throwIfAborted();

    if (run?.prompt) {
      await set(
        saveRunSummary$,
        {
          runId: callback.runId,
          triggerSource: "email",
          prompt: run.prompt,
          resultText: rawOutput ?? "",
        },
        signal,
      );
      signal.throwIfAborted();
    }

    return successResponse();
  },
);

const verifiedEmailTriggerCallbackRoute$ = callbackRoute(
  handleVerifiedEmailTriggerCallback$,
);

const handleEmailTriggerCallbackRoute$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!isResendConfigured()) {
      return successResponse(true);
    }
    return await set(verifiedEmailTriggerCallbackRoute$, signal);
  },
);

export const zeroEmailCallbackRoutes: readonly RouteEntry[] = [
  {
    route: zeroEmailReplyCallbackContract.post,
    handler: callbackRoute(handleEmailReplyCallback$),
  },
  {
    route: zeroEmailTriggerCallbackContract.post,
    handler: handleEmailTriggerCallbackRoute$,
  },
];
