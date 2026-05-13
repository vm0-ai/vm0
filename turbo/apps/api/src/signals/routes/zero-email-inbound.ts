import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { zeroEmailInboundContract } from "@vm0/api-contracts/contracts/zero-email";
import { emailSuppressions } from "@vm0/db/schema/email-suppression";
import { emailThreadSessions } from "@vm0/db/schema/email-thread-session";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import { now } from "../external/time";
import type { RouteEntry } from "../route";
import { createZeroRun$ } from "../services/zero-runs-create.service";
import {
  apiUrl,
  buildFromAddress,
  buildIntegrationPrompt,
  computeReplyRecipients,
  enqueueEmail$,
  extractEmailBody,
  generateCallbackSecret,
  generateReplyToken,
  getFromDomain,
  getOrgIdBySlug,
  getReceivedEmail,
  getSvixHeaders,
  getUserIdByEmail,
  isReplyAddress,
  isResendConfigured,
  parseOrgEmailAddress,
  processEmailAttachments,
  resolveDefaultAgent,
  type HandlerResult,
  unsubscribeUser,
  userHasOrgMembership,
  verifyReplyToken,
  verifyResendWebhook,
  verifySenderAuthenticity,
} from "../services/zero-email-common.service";
import { safeAsync } from "../utils";

const log = logger("zero:email:inbound");

interface WebhookEvent {
  readonly type?: string;
  readonly data?: {
    readonly to?: readonly string[];
    readonly from?: string;
    readonly subject?: string;
    readonly email_id?: string;
    readonly created_at?: string;
  };
}

interface InboundEmailEvent {
  readonly type: "email.received";
  readonly data: {
    readonly email_id: string;
    readonly to: readonly string[];
    readonly from: string;
    readonly subject: string;
    readonly created_at?: string;
  };
}

function jsonResponse(
  body: { readonly received: true } | { readonly error: string },
  status = 200,
): Response {
  return Response.json(body, { status });
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const key = Object.keys(headers).find((candidate) => {
    return candidate.toLowerCase() === name.toLowerCase();
  });
  return key ? headers[key] : undefined;
}

function asReceivedEvent(event: WebhookEvent): InboundEmailEvent | null {
  if (event.type !== "email.received") {
    return null;
  }
  const data = event.data;
  if (
    !data ||
    typeof data.email_id !== "string" ||
    typeof data.from !== "string" ||
    !Array.isArray(data.to)
  ) {
    return null;
  }
  return {
    type: "email.received",
    data: {
      email_id: data.email_id,
      to: data.to,
      from: data.from,
      subject: data.subject ?? "",
      created_at: data.created_at,
    },
  };
}

function expiredThreadResult(): HandlerResult {
  return {
    ok: false,
    errorMessage: "This conversation thread has expired or is no longer valid.",
  };
}

function verifiedReplyToken(replyToAddress: string): string | null {
  const token = replyToAddress.match(/reply\+([^@]+)@/)?.[1];
  if (!token || !verifyReplyToken(token)) {
    return null;
  }
  return token;
}

function orgSlugFromRecipients(recipients: readonly string[]): string | null {
  return (
    recipients
      .map((address) => {
        return parseOrgEmailAddress(address);
      })
      .find((slug): slug is string => {
        return Boolean(slug);
      }) ?? null
  );
}

function replyCallbacks(args: {
  readonly emailThreadSessionId: string;
  readonly inboundEmailId: string;
  readonly inboundMessageId?: string;
  readonly inboundReferences?: string;
  readonly replyRecipients: {
    readonly to: readonly string[];
    readonly cc: readonly string[];
  };
}) {
  return [
    {
      url: `${apiUrl()}/api/zero/email/callbacks/reply`,
      secret: generateCallbackSecret(),
      payload: {
        emailThreadSessionId: args.emailThreadSessionId,
        inboundEmailId: args.inboundEmailId,
        inboundMessageId: args.inboundMessageId,
        inboundReferences: args.inboundReferences,
        replyRecipientTo: args.replyRecipients.to,
        replyRecipientCc: args.replyRecipients.cc,
      },
    },
  ];
}

function triggerCallbacks(args: {
  readonly senderEmail: string;
  readonly agentId: string;
  readonly userId: string;
  readonly inboundEmailId: string;
  readonly replyToken: string;
  readonly inboundMessageId?: string;
  readonly inboundReferences?: string;
  readonly subject: string;
  readonly runtimeOrgId: string;
  readonly replyRecipients: {
    readonly to: readonly string[];
    readonly cc: readonly string[];
  };
}) {
  return [
    {
      url: `${apiUrl()}/api/zero/email/callbacks/trigger`,
      secret: generateCallbackSecret(),
      payload: {
        senderEmail: args.senderEmail,
        agentId: args.agentId,
        userId: args.userId,
        inboundEmailId: args.inboundEmailId,
        replyToken: args.replyToken,
        inboundMessageId: args.inboundMessageId,
        inboundReferences: args.inboundReferences,
        subject: args.subject,
        runtimeOrgId: args.runtimeOrgId,
        replyRecipientTo: args.replyRecipients.to,
        replyRecipientCc: args.replyRecipients.cc,
      },
    },
  ];
}

function runErrorMessage(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    "body" in result &&
    result.body &&
    typeof result.body === "object" &&
    "error" in result.body &&
    result.body.error &&
    typeof result.body.error === "object" &&
    "message" in result.body.error &&
    typeof result.body.error.message === "string"
  ) {
    return result.body.error.message;
  }
  return "Failed to create the agent run.";
}

const sendInboundErrorReply$ = command(
  async (
    { set },
    opts: {
      readonly to: string;
      readonly subject: string;
      readonly errorMessage: string;
      readonly userId?: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (!isResendConfigured()) {
      return;
    }

    const subject = opts.subject
      ? `Re: ${opts.subject.replace(/^Re:\s*/i, "")}`
      : "Email delivery failed";
    await set(
      enqueueEmail$,
      {
        from: buildFromAddress("vm0"),
        to: opts.to,
        subject,
        template: {
          template: "inbound-error",
          props: { errorMessage: opts.errorMessage },
        },
      },
      signal,
    );
  },
);

const handleBounce$ = command(
  async ({ set }, event: WebhookEvent, signal: AbortSignal): Promise<void> => {
    const recipients = event.data?.to ?? [];
    if (recipients.length === 0) {
      return;
    }
    const db = set(writeDb$);
    await db
      .insert(emailSuppressions)
      .values(
        recipients.map((address) => {
          return {
            emailAddress: address,
            reason: "bounced",
            resendEmailId: event.data?.email_id ?? null,
          };
        }),
      )
      .onConflictDoNothing();
    signal.throwIfAborted();
  },
);

const handleComplaint$ = command(
  async (
    { get, set },
    event: WebhookEvent,
    signal: AbortSignal,
  ): Promise<void> => {
    const recipients = event.data?.to ?? [];
    if (recipients.length === 0) {
      return;
    }
    const db = set(writeDb$);
    await db
      .insert(emailSuppressions)
      .values(
        recipients.map((address) => {
          return {
            emailAddress: address,
            reason: "complained",
            resendEmailId: event.data?.email_id ?? null,
          };
        }),
      )
      .onConflictDoNothing();
    signal.throwIfAborted();

    const clerk = get(clerk$);
    for (const address of recipients) {
      const userId = await getUserIdByEmail(db, clerk, address);
      signal.throwIfAborted();
      if (userId) {
        await unsubscribeUser(db, userId);
        signal.throwIfAborted();
      }
    }
  },
);

const handleInboundEmailReply$ = command(
  async (
    { get, set },
    args: { readonly event: InboundEmailEvent; readonly apiStartTime: number },
    signal: AbortSignal,
  ): Promise<HandlerResult> => {
    const replyToAddress = args.event.data.to.find((address) => {
      return address.includes("reply+");
    });
    if (!replyToAddress) {
      return {
        ok: false,
        errorMessage: "The reply address could not be recognized.",
      };
    }

    const token = verifiedReplyToken(replyToAddress);
    if (!token) {
      return expiredThreadResult();
    }

    const db = set(writeDb$);
    const [session] = await db
      .select()
      .from(emailThreadSessions)
      .where(eq(emailThreadSessions.replyToToken, token))
      .limit(1);
    signal.throwIfAborted();
    if (!session) {
      return expiredThreadResult();
    }
    const [agent] = await db
      .select({ orgId: zeroAgents.orgId })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, session.agentId))
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return {
        ok: false,
        errorMessage: "The agent for this email thread no longer exists.",
      };
    }

    const senderEmail = args.event.data.from;
    const senderUserId = await getUserIdByEmail(db, get(clerk$), senderEmail);
    signal.throwIfAborted();
    if (!senderUserId) {
      return {
        ok: false,
        errorMessage:
          "Your email address is not associated with a VM0 account.",
      };
    }
    if (senderUserId !== session.userId) {
      return {
        ok: false,
        errorMessage:
          "Only the original sender can continue this email conversation.",
      };
    }

    const email = await getReceivedEmail(args.event.data.email_id);
    signal.throwIfAborted();
    const verification = verifySenderAuthenticity(email.headers);
    if (!verification.verified) {
      return {
        ok: false,
        errorMessage:
          "Your email could not be authenticated (DMARC verification failed).",
      };
    }

    const replyRecipients = computeReplyRecipients({
      from: args.event.data.from,
      to: email.to,
      cc: email.cc,
      replyTo: email.replyTo,
      botDomain: getFromDomain(),
    });
    const inboundMessageId = headerValue(email.headers, "message-id");
    const inboundReferences = headerValue(email.headers, "references");
    let prompt = extractEmailBody(email.html, email.text);
    if (!prompt.trim()) {
      return {
        ok: false,
        errorMessage: "Your reply was empty after processing.",
      };
    }
    const attachmentText = await get(
      processEmailAttachments(args.event.data.email_id),
    );
    signal.throwIfAborted();
    if (attachmentText) {
      prompt = `${prompt}\n\n${attachmentText}`;
    }

    const result = await set(
      createZeroRun$,
      {
        auth: {
          tokenType: "session",
          userId: session.userId,
          orgId: session.orgId ?? agent.orgId,
          orgRole: "member",
        },
        body: {
          agentId: session.agentId,
          sessionId: session.agentSessionId,
          prompt,
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "email",
        appendSystemPrompt: buildIntegrationPrompt(),
        callbacks: replyCallbacks({
          emailThreadSessionId: session.id,
          inboundEmailId: args.event.data.email_id,
          inboundMessageId,
          inboundReferences,
          replyRecipients,
        }),
      },
      signal,
    );
    signal.throwIfAborted();
    return result.status === 201
      ? { ok: true }
      : { ok: false, errorMessage: runErrorMessage(result) };
  },
);

const handleInboundEmailTrigger$ = command(
  async (
    { get, set },
    args: { readonly event: InboundEmailEvent; readonly apiStartTime: number },
    signal: AbortSignal,
  ): Promise<HandlerResult> => {
    const db = set(writeDb$);
    const clerk = get(clerk$);
    const orgSlug = orgSlugFromRecipients(args.event.data.to);
    if (!orgSlug) {
      return {
        ok: false,
        errorMessage:
          "The email address could not be recognized as a valid org address.",
      };
    }

    const userId = await getUserIdByEmail(db, clerk, args.event.data.from);
    signal.throwIfAborted();
    if (!userId) {
      return {
        ok: false,
        errorMessage:
          "Your email address is not associated with a VM0 account.",
      };
    }

    const orgId = await getOrgIdBySlug(db, clerk, orgSlug);
    signal.throwIfAborted();
    if (!orgId) {
      return {
        ok: false,
        errorMessage: `Workspace "${orgSlug}" was not found.`,
      };
    }

    const isMember = await userHasOrgMembership(db, clerk, orgId, userId);
    signal.throwIfAborted();
    if (!isMember) {
      return {
        ok: false,
        errorMessage: "You are not a member of this workspace.",
      };
    }

    const agentId = await resolveDefaultAgent(db, orgId);
    signal.throwIfAborted();
    if (!agentId) {
      return {
        ok: false,
        errorMessage:
          "This workspace does not have a default agent configured.",
      };
    }

    const email = await getReceivedEmail(args.event.data.email_id);
    signal.throwIfAborted();
    const replyRecipients = computeReplyRecipients({
      from: args.event.data.from,
      to: email.to,
      cc: email.cc,
      replyTo: email.replyTo,
      botDomain: getFromDomain(),
    });
    const verification = verifySenderAuthenticity(email.headers);
    if (!verification.verified) {
      return {
        ok: false,
        errorMessage:
          "Your email could not be authenticated (DMARC verification failed).",
      };
    }

    const bodyContent = extractEmailBody(email.html, email.text);
    let prompt = args.event.data.subject
      ? `${args.event.data.subject}\n\n${bodyContent}`.trim()
      : bodyContent.trim();
    if (!prompt) {
      return {
        ok: false,
        errorMessage: "Your email body was empty after processing.",
      };
    }
    const attachmentText = await get(
      processEmailAttachments(args.event.data.email_id),
    );
    signal.throwIfAborted();
    if (attachmentText) {
      prompt = `${prompt}\n\n${attachmentText}`;
    }

    const replyToken = generateReplyToken(randomUUID());
    const result = await set(
      createZeroRun$,
      {
        auth: {
          tokenType: "session",
          userId,
          orgId,
          orgRole: "member",
        },
        body: {
          agentId,
          prompt,
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "email",
        appendSystemPrompt: buildIntegrationPrompt(),
        callbacks: triggerCallbacks({
          senderEmail: args.event.data.from,
          agentId,
          userId,
          inboundEmailId: args.event.data.email_id,
          replyToken,
          inboundMessageId: headerValue(email.headers, "message-id"),
          inboundReferences: headerValue(email.headers, "references"),
          subject: args.event.data.subject,
          runtimeOrgId: orgId,
          replyRecipients,
        }),
      },
      signal,
    );
    signal.throwIfAborted();
    return result.status === 201
      ? { ok: true }
      : { ok: false, errorMessage: runErrorMessage(result) };
  },
);

const processReceivedEmail$ = command(
  async (
    { set },
    args: {
      readonly event: InboundEmailEvent;
      readonly hasReplyAddress: boolean;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const result = await safeAsync(async () => {
      const handlerResult = await set(
        args.hasReplyAddress
          ? handleInboundEmailReply$
          : handleInboundEmailTrigger$,
        { event: args.event, apiStartTime: args.apiStartTime },
        signal,
      );
      signal.throwIfAborted();
      if (!handlerResult.ok && args.event.data.from) {
        await set(
          sendInboundErrorReply$,
          {
            to: args.event.data.from,
            subject: args.event.data.subject,
            errorMessage: handlerResult.errorMessage,
          },
          signal,
        );
      }
    });
    signal.throwIfAborted();
    if ("error" in result) {
      log.error("Failed to handle inbound email", { error: result.error });
      const sendResult = await safeAsync(() => {
        return set(
          sendInboundErrorReply$,
          {
            to: args.event.data.from,
            subject: args.event.data.subject,
            errorMessage:
              "An internal error occurred while processing your email. Please try again later.",
          },
          signal,
        );
      });
      signal.throwIfAborted();
      if ("error" in sendResult) {
        log.error("Failed to send inbound email error reply", {
          sendError: sendResult.error,
        });
      }
    }
  },
);

const handleInboundRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const apiStartTime = now();
    const req = get(request$);
    const svixHeaders = getSvixHeaders(req.raw.headers);
    if (!svixHeaders) {
      return jsonResponse({ error: "Missing signature headers" }, 401);
    }

    const rawBody = await req.text();
    signal.throwIfAborted();

    const payloadResult = await safeAsync(() => {
      return Promise.resolve(verifyResendWebhook(rawBody, svixHeaders));
    });
    signal.throwIfAborted();
    if ("error" in payloadResult) {
      log.warn("Webhook signature verification failed");
      return jsonResponse({ error: "Invalid signature" }, 401);
    }

    const event = payloadResult.ok as WebhookEvent;
    if (event.type === "email.bounced") {
      await set(handleBounce$, event, signal);
      signal.throwIfAborted();
      return jsonResponse({ received: true });
    }
    if (event.type === "email.complained") {
      await set(handleComplaint$, event, signal);
      signal.throwIfAborted();
      return jsonResponse({ received: true });
    }
    if (event.type !== "email.received") {
      return jsonResponse({ received: true });
    }

    const received = asReceivedEvent(event);
    if (!received) {
      return jsonResponse({ received: true });
    }
    const hasReplyAddress = received.data.to.some(isReplyAddress);
    const backgroundSignal = new AbortController().signal;
    waitUntil(
      set(
        processReceivedEmail$,
        { event: received, hasReplyAddress, apiStartTime },
        backgroundSignal,
      ),
    );

    return jsonResponse({ received: true });
  },
);

export const zeroEmailInboundRoutes: readonly RouteEntry[] = [
  {
    route: zeroEmailInboundContract.post,
    handler: handleInboundRoute$,
  },
];
