import { NextResponse, after } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import {
  verifyResendWebhook,
  getSvixHeaders,
} from "../../../../../src/lib/email/verify";
import { handleInboundEmailReply } from "../../../../../src/lib/email/handlers/inbound-reply";
import { handleInboundEmailTrigger } from "../../../../../src/lib/email/handlers/inbound-trigger";
import {
  isReplyAddress,
  sendInboundErrorReply,
} from "../../../../../src/lib/email/handlers/shared";
import { emailSuppressions } from "../../../../../src/db/schema/email-suppression";
import { getCachedUserIdByEmail } from "../../../../../src/lib/auth/user-cache-service";
import { unsubscribeUser } from "../../../../../src/lib/email/unsubscribe-service";
import { logger } from "../../../../../src/lib/logger";

const log = logger("zero:email:inbound");

interface WebhookEvent {
  type?: string;
  data?: {
    to?: string[];
    from?: string;
    subject?: string;
    email_id?: string;
  };
}

/**
 * Handle email.bounced event — insert suppression for each recipient.
 */
async function handleBounce(event: WebhookEvent): Promise<Response> {
  const recipients = event.data?.to ?? [];
  for (const addr of recipients) {
    await globalThis.services.db
      .insert(emailSuppressions)
      .values({
        emailAddress: addr,
        reason: "bounced",
        resendEmailId: event.data?.email_id ?? null,
      })
      .onConflictDoNothing();
  }
  log.debug("Processed email.bounced event", { recipients });
  return NextResponse.json({ received: true });
}

/**
 * Handle email.complained event — insert suppression + unsubscribe user.
 */
async function handleComplaint(event: WebhookEvent): Promise<Response> {
  const recipients = event.data?.to ?? [];
  for (const addr of recipients) {
    await globalThis.services.db
      .insert(emailSuppressions)
      .values({
        emailAddress: addr,
        reason: "complained",
        resendEmailId: event.data?.email_id ?? null,
      })
      .onConflictDoNothing();

    const userId = await getCachedUserIdByEmail(addr);
    if (userId) {
      await unsubscribeUser(userId);
    }
  }
  log.debug("Processed email.complained event", { recipients });
  return NextResponse.json({ received: true });
}

/**
 * Resend Inbound Email Webhook
 *
 * POST /api/zero/email/inbound
 *
 * Receives inbound email events from Resend via Svix.
 * Routes to appropriate handler based on email address type:
 * - reply+{token}@domain → handleInboundEmailReply (continue conversation)
 * - {org}+{agent}@domain → handleInboundEmailTrigger (new agent run, explicit org)
 * - {agent}@domain → handleInboundEmailTrigger (new agent run, org from sender)
 *
 * Verifies the webhook signature and dispatches handling in the background.
 * Returns 200 immediately to acknowledge receipt.
 */
export async function POST(request: Request): Promise<Response> {
  initServices();

  // 1. Extract Svix signature headers
  const svixHeaders = getSvixHeaders(request.headers);
  if (!svixHeaders) {
    return NextResponse.json(
      { error: "Missing signature headers" },
      { status: 401 },
    );
  }

  // 2. Read and verify the webhook payload
  const rawBody = await request.text();

  let payload: unknown;
  try {
    payload = verifyResendWebhook(rawBody, svixHeaders);
  } catch {
    log.warn("Webhook signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // 3. Check event type and route accordingly
  const event = payload as WebhookEvent;

  if (event.type === "email.bounced") {
    return handleBounce(event);
  }

  if (event.type === "email.complained") {
    return handleComplaint(event);
  }

  if (event.type !== "email.received") {
    return NextResponse.json({ received: true });
  }

  // 4. Route to appropriate handler based on address type
  const toAddresses = event.data?.to ?? [];
  const hasReplyAddress = toAddresses.some(isReplyAddress);

  const senderEmail = event.data?.from ?? "";
  const senderSubject = event.data?.subject ?? "";

  // 5. Dispatch handling in the background
  after(async () => {
    try {
      const result = hasReplyAddress
        ? await handleInboundEmailReply(
            event as Parameters<typeof handleInboundEmailReply>[0],
          )
        : await handleInboundEmailTrigger(
            event as Parameters<typeof handleInboundEmailTrigger>[0],
          );

      if (!result.ok && senderEmail) {
        await sendInboundErrorReply({
          to: senderEmail,
          subject: senderSubject,
          errorMessage: result.errorMessage,
        });
      }
    } catch (err) {
      log.error("Failed to handle inbound email", {
        err,
        type: hasReplyAddress ? "reply" : "trigger",
      });

      if (senderEmail) {
        await sendInboundErrorReply({
          to: senderEmail,
          subject: senderSubject,
          errorMessage:
            "An internal error occurred while processing your email. Please try again later.",
        }).catch((sendErr) =>
          log.error("Failed to send error reply", { sendErr }),
        );
      }
    }
  });

  return NextResponse.json({ received: true });
}
