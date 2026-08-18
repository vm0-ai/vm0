import { command } from "ccstate";
import { emailInboundContract } from "@okouai/api-contracts/contracts/email";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";

import { request$ } from "../context/hono";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import { waitUntil } from "../context/wait-until";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route-entry";
import {
  getSvixHeaders,
  getUserIdByEmail,
  unsubscribeUser,
  verifyResendWebhook,
} from "../services/zero-email-common.service";
import { ingestWeeklyProductUpdateBroadcast$ } from "../services/weekly-product-update.service";
import { safeSync, tapError } from "../utils";

const L = logger("EmailInboundRoute");

interface WebhookEvent {
  readonly type?: string;
  readonly data?: {
    readonly to?: readonly string[];
    readonly email_id?: string;
    readonly broadcast_id?: string;
  };
}

function jsonResponse(
  body: { readonly received: true } | { readonly error: string },
  status = 200,
): Response {
  return Response.json(body, { status });
}

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

const handleInboundRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const req = get(request$);
    const svixHeaders = getSvixHeaders(req.raw.headers);
    if (!svixHeaders) {
      return jsonResponse({ error: "Missing signature headers" }, 401);
    }

    const rawBody = await req.text();
    signal.throwIfAborted();

    const payloadResult = safeSync(() => {
      return verifyResendWebhook(rawBody, svixHeaders);
    });
    signal.throwIfAborted();
    if ("error" in payloadResult) {
      return jsonResponse({ error: "Invalid signature" }, 401);
    }

    const event = payloadResult.ok as WebhookEvent;
    if (event.type === "email.bounced") {
      await set(handleBounce$, event, signal);
      signal.throwIfAborted();
    } else if (event.type === "email.complained") {
      await set(handleComplaint$, event, signal);
      signal.throwIfAborted();
    } else if (event.type === "email.sent" && event.data?.broadcast_id) {
      // A broadcast emits one `email.sent` per recipient. The claim inside the
      // command keeps only the first, so the rest cost a single indexed insert.
      const broadcastId = event.data.broadcast_id;
      waitUntil(
        tapError(
          set(ingestWeeklyProductUpdateBroadcast$, broadcastId, signal),
          (error) => {
            L.error("weekly product update ingest failed", {
              broadcastId,
              error,
            });
          },
        ),
      );
    }

    // The Agent Email Channel is retired. Resend still sends delivery events
    // to this shared webhook, so all other signed event types are acknowledged
    // without fetching message contents or starting background work.
    return jsonResponse({ received: true });
  },
);

export const emailInboundRoutes: readonly RouteEntry[] = [
  {
    route: emailInboundContract.post,
    handler: handleInboundRoute$,
  },
];
