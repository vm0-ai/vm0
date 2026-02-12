import { NextResponse, after } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import {
  verifyResendWebhook,
  getSvixHeaders,
} from "../../../../../src/lib/email/verify";
import { handleInboundEmailReply } from "../../../../../src/lib/email/handlers/inbound-reply";
import { logger } from "../../../../../src/lib/logger";

const log = logger("webhook:email:inbound");

/**
 * Resend Inbound Email Webhook
 *
 * POST /api/webhooks/email/inbound
 *
 * Receives inbound email events from Resend via Svix.
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

  // 3. Check event type
  const event = payload as { type?: string; data?: Record<string, unknown> };
  if (event.type !== "email.received") {
    // Acknowledge non-inbound events silently
    return NextResponse.json({ received: true });
  }

  // 4. Dispatch handling in the background (fire-and-forget)
  after(() =>
    handleInboundEmailReply(
      event as Parameters<typeof handleInboundEmailReply>[0],
    ).catch((err) =>
      log.error("Failed to handle inbound email reply", { err }),
    ),
  );

  return NextResponse.json({ received: true });
}
