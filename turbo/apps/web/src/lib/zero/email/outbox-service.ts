import { eq, and, or, lt, sql } from "drizzle-orm";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { emailSuppressions } from "@vm0/db/schema/email-suppression";
import { resolveTemplate } from "./template-registry";
import { sendEmailDirect, getMessageId } from "./client";
import {
  saveEmailThreadSession,
  updateEmailThreadSession,
} from "./handlers/shared";
import { logger } from "../../shared/logger";
import type { EnqueueEmailOptions, PostSendAction } from "./types";

const log = logger("email:outbox");

// Max 3 attempts, exponential backoff: 1s, 4s, 16s
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

// Max items per drain batch (2 req/s × 60s, conservative)
const MAX_BATCH_SIZE = 120;

// Delay between sends to stay under 2 req/s
const DRAIN_DELAY_MS = 500;

// TTL for expired outbox items
const OUTBOX_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Row shape from raw SQL queries
type OutboxRow = Record<string, unknown> & {
  id: string;
  from_address: string;
  to_addresses: unknown;
  cc_addresses: unknown;
  subject: string;
  reply_to: string | null;
  headers: unknown;
  template: unknown;
  post_send_action: unknown;
  attempts: number;
};

/**
 * Enqueue an email for delivery via the outbox.
 * Inserts a row and attempts immediate inline drain (best-effort).
 * If the inline drain fails, the cron job will pick it up later.
 */
export async function enqueueEmail(
  options: EnqueueEmailOptions,
): Promise<void> {
  const [row] = await globalThis.services.db
    .insert(emailOutbox)
    .values({
      fromAddress: options.from,
      toAddresses: options.to,
      ccAddresses: options.cc ?? null,
      subject: options.subject,
      replyTo: options.replyTo ?? null,
      headers: options.headers ?? null,
      template: options.template,
      postSendAction: options.threadAction ?? null,
      status: "pending",
      attempts: 0,
    })
    .returning({ id: emailOutbox.id });

  // Best-effort inline drain of the just-inserted item
  try {
    await drainById(row!.id);
  } catch (error) {
    log.debug("Inline drain failed, cron will retry", {
      id: row!.id,
      error,
    });
  }
}

/**
 * Drain a specific outbox item by ID.
 * Used for inline drain after enqueue to avoid processing stale items.
 */
export async function drainById(itemId: string): Promise<boolean> {
  return globalThis.services.db.transaction(async (tx) => {
    const rows = await tx.execute<OutboxRow>(
      sql`SELECT id, from_address, to_addresses, cc_addresses, subject,
             reply_to, headers, template, post_send_action, attempts
          FROM email_outbox
          WHERE id = ${itemId}
            AND status = 'pending'
          FOR UPDATE SKIP LOCKED`,
    );

    const row = rows.rows[0];
    if (!row) return false;

    return processItem(tx, row);
  });
}

/**
 * Drain the next pending email from the outbox.
 * Uses SELECT FOR UPDATE SKIP LOCKED to prevent concurrent processing.
 * Returns true if an item was processed, false if queue is empty.
 */
async function drainNext(): Promise<boolean> {
  return globalThis.services.db.transaction(async (tx) => {
    const rows = await tx.execute<OutboxRow>(
      sql`SELECT id, from_address, to_addresses, cc_addresses, subject,
             reply_to, headers, template, post_send_action, attempts
          FROM email_outbox
          WHERE status = 'pending'
            AND (next_retry_at IS NULL OR next_retry_at <= NOW())
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
    );

    const row = rows.rows[0];
    if (!row) return false;

    return processItem(tx, row);
  });
}

/**
 * Process a single outbox item: send via Resend, handle retry/failure, execute post-send actions.
 */
async function processItem(
  tx: Parameters<Parameters<typeof globalThis.services.db.transaction>[0]>[0],
  row: OutboxRow,
): Promise<true> {
  const itemId = row.id;
  const attempts = row.attempts + 1;

  // Mark as sending
  await tx
    .update(emailOutbox)
    .set({ status: "sending", attempts })
    .where(eq(emailOutbox.id, itemId));

  // Check if any recipient is suppressed (bounced/complained)
  const toAddresses = normalizeAddresses(row.to_addresses);
  const suppressedAddress = await findSuppressedAddress(tx, toAddresses);
  if (suppressedAddress) {
    await tx
      .update(emailOutbox)
      .set({
        status: "failed",
        lastError: `Recipient address suppressed (${suppressedAddress})`,
      })
      .where(eq(emailOutbox.id, itemId));
    log.debug(`Email ${itemId} skipped: recipient suppressed`, {
      address: suppressedAddress,
    });
    return true;
  }

  // Resolve template to React element
  const template = row.template as Parameters<typeof resolveTemplate>[0];
  const react = resolveTemplate(template);

  // Attempt to send via Resend
  const result = await sendEmailDirect({
    from: row.from_address,
    to: row.to_addresses as string | string[],
    subject: row.subject,
    react,
    cc: (row.cc_addresses as string | string[] | null) ?? undefined,
    replyTo: row.reply_to ?? undefined,
    headers: (row.headers as Record<string, string> | null) ?? undefined,
  });

  if (!result.ok) {
    // Send failed — retry or mark as permanently failed
    if (attempts < MAX_ATTEMPTS) {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(4, attempts - 1);
      const nextRetryAt = new Date(Date.now() + backoffMs);
      await tx
        .update(emailOutbox)
        .set({
          status: "pending",
          lastError: result.error,
          nextRetryAt,
        })
        .where(eq(emailOutbox.id, itemId));
      log.warn(
        `Email ${itemId} failed (attempt ${attempts}/${MAX_ATTEMPTS}), retry at ${nextRetryAt.toISOString()}`,
        { error: result.error },
      );
    } else {
      await tx
        .update(emailOutbox)
        .set({
          status: "failed",
          lastError: result.error,
        })
        .where(eq(emailOutbox.id, itemId));
      log.error(
        `Email ${itemId} permanently failed after ${MAX_ATTEMPTS} attempts`,
        { error: result.error },
      );
    }
    return true;
  }

  // Send succeeded — mark as sent
  await tx
    .update(emailOutbox)
    .set({ status: "sent", resendId: result.resendId })
    .where(eq(emailOutbox.id, itemId));

  // Execute post-send action if present
  const postSendAction = row.post_send_action as PostSendAction | null;
  if (postSendAction) {
    await executePostSendAction(postSendAction, result.resendId);
  }

  log.debug(`Email ${itemId} sent successfully`, {
    resendId: result.resendId,
  });
  return true;
}

/**
 * Drain pending emails in batch. Called by cron every minute.
 * Processes items one at a time with 500ms delay to stay under 2 req/s.
 */
export async function drainBatch(): Promise<number> {
  let processed = 0;

  for (let i = 0; i < MAX_BATCH_SIZE; i++) {
    const hadItem = await drainNext();
    if (!hadItem) break;
    processed++;

    // Delay between sends to respect rate limit
    if (i < MAX_BATCH_SIZE - 1) {
      await new Promise((resolve) => {
        return setTimeout(resolve, DRAIN_DELAY_MS);
      });
    }
  }

  if (processed > 0) {
    log.debug(`Drained ${processed} emails from outbox`);
  }
  return processed;
}

/**
 * Clean up expired outbox items older than TTL.
 * Removes pending and failed items that exceeded the 15-minute window.
 */
export async function cleanupExpiredOutbox(): Promise<number> {
  const cutoff = new Date(Date.now() - OUTBOX_TTL_MS);

  const deleted = await globalThis.services.db
    .delete(emailOutbox)
    .where(
      and(
        lt(emailOutbox.createdAt, cutoff),
        or(eq(emailOutbox.status, "pending"), eq(emailOutbox.status, "failed")),
      ),
    )
    .returning({ id: emailOutbox.id });

  if (deleted.length > 0) {
    log.debug(`Cleaned up ${deleted.length} expired outbox items`);
  }
  return deleted.length;
}

/**
 * Normalize to_addresses (string or string[]) to a flat string array.
 */
function normalizeAddresses(raw: unknown): string[] {
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw))
    return raw.filter((x): x is string => {
      return typeof x === "string";
    });
  return [];
}

/**
 * Check if any address in the list is suppressed.
 * Returns the first suppressed address found, or null.
 */
async function findSuppressedAddress(
  tx: Parameters<Parameters<typeof globalThis.services.db.transaction>[0]>[0],
  addresses: string[],
): Promise<string | null> {
  if (addresses.length === 0) return null;

  const lowerAddresses = addresses.map((a) => {
    return a.toLowerCase();
  });
  const results = await tx
    .select({ emailAddress: emailSuppressions.emailAddress })
    .from(emailSuppressions)
    .where(
      sql`lower(${emailSuppressions.emailAddress}) IN (${sql.join(
        lowerAddresses.map((a) => {
          return sql`${a}`;
        }),
        sql`, `,
      )})`,
    )
    .limit(1);

  if (results.length > 0) {
    // Return the original-cased address that matched
    const matchedLower = results[0]!.emailAddress.toLowerCase();
    return (
      addresses.find((a) => {
        return a.toLowerCase() === matchedLower;
      }) ?? matchedLower
    );
  }
  return null;
}

/**
 * Execute a post-send action after successful email delivery.
 * Retrieves the RFC Message-ID from Resend and saves/updates the thread session.
 */
async function executePostSendAction(
  action: PostSendAction,
  resendId: string,
): Promise<void> {
  // Retrieve RFC Message-ID for threading (graceful on failure)
  const messageId = await getMessageId(resendId);

  switch (action.action) {
    case "save_thread_session":
      await saveEmailThreadSession({
        userId: action.userId,
        agentId: action.agentId,
        agentSessionId: action.agentSessionId,
        lastEmailMessageId: messageId,
        replyToToken: action.replyToToken,
        orgId: action.orgId,
      });
      break;

    case "update_thread_session":
      await updateEmailThreadSession(action.sessionId, {
        ...(action.agentSessionId
          ? { agentSessionId: action.agentSessionId }
          : {}),
        lastEmailMessageId: messageId,
      });
      break;
  }
}
