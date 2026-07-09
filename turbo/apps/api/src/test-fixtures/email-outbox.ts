import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";
import { now } from "../lib/time";

/**
 * Direct email-outbox row helpers for exercising the drain cron
 * (`POST /api/cron/drain-email-outbox`).
 *
 * Why product APIs cannot construct or observe this state deterministically:
 * - Aged rows (past the 15-minute expiry window), specific `attempts` counts,
 *   and far-future `nextRetryAt` values only arise from wall-clock time
 *   passing between real sends; the inbound webhook always enqueues fresh
 *   rows and drains them inline.
 * - The drain cron only reports global `drained`/`cleaned` counts across all
 *   orgs sharing the persistent test database, so a per-row outcome (failed
 *   with a suppression error, cleaned up when expired) has no deterministic
 *   product read surface.
 */

interface InsertEmailOutboxRowOptions {
  readonly subject: string;
  readonly to: string;
  readonly status?: string;
  readonly attempts?: number;
  readonly createdAt?: Date;
  readonly nextRetryAt?: Date | null;
}

const OUTBOX_TEST_FROM = "Zero <bdd-outbox@mail.example.com>";
const OUTBOX_TEST_CREATED_AT_OFFSET_MS = 10 * 60 * 1000;

export async function insertEmailOutboxRow(
  options: InsertEmailOutboxRowOptions,
): Promise<void> {
  await db()
    .insert(emailOutbox)
    .values({
      fromAddress: OUTBOX_TEST_FROM,
      toAddresses: options.to,
      subject: options.subject,
      template: {
        template: "inbound-error",
        props: { errorMessage: "BDD outbox test email" },
      },
      status: options.status ?? "pending",
      attempts: options.attempts ?? 0,
      createdAt:
        options.createdAt ?? new Date(now() - OUTBOX_TEST_CREATED_AT_OFFSET_MS),
      nextRetryAt: options.nextRetryAt ?? null,
    });
}

/** Re-dates a row so poll loops can keep it inside the drain window. */
export async function touchEmailOutboxRow(
  subject: string,
  createdAt: Date,
): Promise<void> {
  const updated = await db()
    .update(emailOutbox)
    .set({ createdAt })
    .where(eq(emailOutbox.subject, subject))
    .returning({ id: emailOutbox.id });
  if (updated.length === 0) {
    throw new Error(`email outbox row not found for ${subject}`);
  }
}

export async function readEmailOutboxRow(subject: string): Promise<{
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
} | null> {
  const [row] = await db()
    .select({
      status: emailOutbox.status,
      attempts: emailOutbox.attempts,
      lastError: emailOutbox.lastError,
    })
    .from(emailOutbox)
    .where(eq(emailOutbox.subject, subject))
    .limit(1);
  return row ?? null;
}
