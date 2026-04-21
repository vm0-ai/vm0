import { eq, and, lt, or, sql } from "drizzle-orm";
import { resendContactOutbox } from "../../../db/schema/resend-contact-outbox";
import { resendContactMapping } from "../../../db/schema/resend-contact-mapping";
import {
  createContact,
  updateContact,
  removeContact,
  getContactByEmail,
  type ResendContactError,
} from "./client";
import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("resend-contacts:outbox");

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const MAX_BATCH_SIZE = 120;
const DRAIN_DELAY_MS = 500;
// Stale pending/failed rows older than this are cleaned up. Longer than
// email_outbox's 15-min TTL because contact sync is not time-sensitive
// and a full backfill may take well over an hour.
const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;

type OutboxRow = {
  id: string;
  op: string;
  clerk_user_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  attempts: number;
};

type OutboxOp = "create" | "update" | "delete";

export interface EnqueueContactOpInput {
  op: OutboxOp;
  clerkUserId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export async function enqueueContactOps(
  items: EnqueueContactOpInput[],
): Promise<number> {
  if (items.length === 0) return 0;

  const rows = items.map((item) => {
    return {
      op: item.op,
      clerkUserId: item.clerkUserId,
      email: item.email ?? null,
      firstName: item.firstName ?? null,
      lastName: item.lastName ?? null,
      status: "pending" as const,
    };
  });

  await globalThis.services.db.insert(resendContactOutbox).values(rows);
  return rows.length;
}

export async function drainBatch(): Promise<number> {
  const segmentId = env().RESEND_CONTACT_SEGMENT_ID;
  if (!segmentId) return 0;

  let processed = 0;
  for (let i = 0; i < MAX_BATCH_SIZE; i++) {
    const hadItem = await drainNext(segmentId);
    if (!hadItem) break;
    processed++;

    if (i < MAX_BATCH_SIZE - 1) {
      await new Promise((resolve) => {
        return setTimeout(resolve, DRAIN_DELAY_MS);
      });
    }
  }

  if (processed > 0) {
    log.debug(`Drained ${processed} contact ops from outbox`);
  }
  return processed;
}

async function drainNext(segmentId: string): Promise<boolean> {
  return globalThis.services.db.transaction(async (tx) => {
    const rows = await tx.execute<OutboxRow>(
      sql`SELECT id, op, clerk_user_id, email, first_name, last_name, attempts
          FROM resend_contact_outbox
          WHERE status = 'pending'
            AND (next_retry_at IS NULL OR next_retry_at <= NOW())
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
    );

    const row = rows.rows[0];
    if (!row) return false;

    await processItem(tx, row, segmentId);
    return true;
  });
}

type Tx = Parameters<
  Parameters<typeof globalThis.services.db.transaction>[0]
>[0];

async function processItem(
  tx: Tx,
  row: OutboxRow,
  segmentId: string,
): Promise<void> {
  const attempts = row.attempts + 1;

  await tx
    .update(resendContactOutbox)
    .set({ status: "sending", attempts })
    .where(eq(resendContactOutbox.id, row.id));

  const op = row.op as OutboxOp;
  const outcome = await dispatchOp(tx, row, op, segmentId);

  if (outcome.ok) {
    await tx
      .update(resendContactOutbox)
      .set({ status: "done" })
      .where(eq(resendContactOutbox.id, row.id));
    return;
  }

  if (attempts < MAX_ATTEMPTS) {
    const backoffMs = BACKOFF_BASE_MS * Math.pow(4, attempts - 1);
    const nextRetryAt = new Date(Date.now() + backoffMs);
    await tx
      .update(resendContactOutbox)
      .set({
        status: "pending",
        lastError: outcome.error,
        nextRetryAt,
      })
      .where(eq(resendContactOutbox.id, row.id));
    log.warn(
      `Contact op ${row.id} failed (attempt ${attempts}/${MAX_ATTEMPTS})`,
      { error: outcome.error, op },
    );
  } else {
    await tx
      .update(resendContactOutbox)
      .set({ status: "failed", lastError: outcome.error })
      .where(eq(resendContactOutbox.id, row.id));
    log.error(
      `Contact op ${row.id} permanently failed after ${MAX_ATTEMPTS} attempts`,
      { error: outcome.error, op },
    );
  }
}

type DispatchOutcome = { ok: true } | { ok: false; error: string };

async function dispatchOp(
  tx: Tx,
  row: OutboxRow,
  op: OutboxOp,
  segmentId: string,
): Promise<DispatchOutcome> {
  switch (op) {
    case "create":
      return handleCreate(tx, row, segmentId);
    case "update":
      return handleUpdate(tx, row);
    case "delete":
      return handleDelete(tx, row);
    default:
      return { ok: false, error: `unknown op: ${op}` };
  }
}

async function handleCreate(
  tx: Tx,
  row: OutboxRow,
  segmentId: string,
): Promise<DispatchOutcome> {
  const email = row.email;
  if (!email) return { ok: false, error: "create op missing email" };

  const result = await createContact(
    {
      email,
      firstName: row.first_name ?? undefined,
      lastName: row.last_name ?? undefined,
    },
    segmentId,
  );

  if (result.ok) {
    await upsertMapping(tx, {
      clerkUserId: row.clerk_user_id,
      resendContactId: result.data.id,
      email,
      firstName: row.first_name,
      lastName: row.last_name,
    });
    return { ok: true };
  }

  if (isAlreadyExists(result.error)) {
    const existing = await getContactByEmail(email);
    if (existing.ok) {
      await upsertMapping(tx, {
        clerkUserId: row.clerk_user_id,
        resendContactId: existing.data.id,
        email,
        firstName: row.first_name,
        lastName: row.last_name,
      });
      return { ok: true };
    }
    return { ok: false, error: existing.error.message };
  }

  return { ok: false, error: result.error.message };
}

async function handleUpdate(tx: Tx, row: OutboxRow): Promise<DispatchOutcome> {
  const email = row.email;
  if (!email) return { ok: false, error: "update op missing email" };

  const mapping = await findMapping(tx, row.clerk_user_id);
  if (!mapping) {
    return {
      ok: false,
      error: `no mapping for clerk user ${row.clerk_user_id}`,
    };
  }

  const result = await updateContact(mapping.resendContactId, {
    email,
    firstName: row.first_name ?? undefined,
    lastName: row.last_name ?? undefined,
  });

  if (result.ok) {
    await upsertMapping(tx, {
      clerkUserId: row.clerk_user_id,
      resendContactId: mapping.resendContactId,
      email,
      firstName: row.first_name,
      lastName: row.last_name,
    });
    return { ok: true };
  }

  if (isNotFound(result.error)) {
    await tx
      .delete(resendContactMapping)
      .where(eq(resendContactMapping.clerkUserId, row.clerk_user_id));
    return { ok: true };
  }

  return { ok: false, error: result.error.message };
}

async function handleDelete(tx: Tx, row: OutboxRow): Promise<DispatchOutcome> {
  const mapping = await findMapping(tx, row.clerk_user_id);
  if (!mapping) {
    return { ok: true };
  }

  const result = await removeContact(mapping.resendContactId);

  if (!result.ok && !isNotFound(result.error)) {
    return { ok: false, error: result.error.message };
  }

  await tx
    .delete(resendContactMapping)
    .where(eq(resendContactMapping.clerkUserId, row.clerk_user_id));
  return { ok: true };
}

async function findMapping(
  tx: Tx,
  clerkUserId: string,
): Promise<{ resendContactId: string } | null> {
  const rows = await tx
    .select({ resendContactId: resendContactMapping.resendContactId })
    .from(resendContactMapping)
    .where(eq(resendContactMapping.clerkUserId, clerkUserId))
    .limit(1);
  return rows[0] ?? null;
}

async function upsertMapping(
  tx: Tx,
  input: {
    clerkUserId: string;
    resendContactId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  },
): Promise<void> {
  await tx
    .insert(resendContactMapping)
    .values({
      clerkUserId: input.clerkUserId,
      resendContactId: input.resendContactId,
      lastEmail: input.email,
      lastFirstName: input.firstName,
      lastLastName: input.lastName,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: resendContactMapping.clerkUserId,
      set: {
        resendContactId: input.resendContactId,
        lastEmail: input.email,
        lastFirstName: input.firstName,
        lastLastName: input.lastName,
        syncedAt: new Date(),
      },
    });
}

function isAlreadyExists(error: ResendContactError): boolean {
  if (error.statusCode === 409) return true;
  const msg = error.message.toLowerCase();
  return msg.includes("already exists") || msg.includes("duplicate");
}

function isNotFound(error: ResendContactError): boolean {
  return error.statusCode === 404 || error.name === "not_found";
}

export async function cleanupExpiredOutbox(): Promise<number> {
  const cutoff = new Date(Date.now() - OUTBOX_TTL_MS);

  const deleted = await globalThis.services.db
    .delete(resendContactOutbox)
    .where(
      and(
        lt(resendContactOutbox.createdAt, cutoff),
        or(
          eq(resendContactOutbox.status, "done"),
          eq(resendContactOutbox.status, "failed"),
        ),
      ),
    )
    .returning({ id: resendContactOutbox.id });

  if (deleted.length > 0) {
    log.debug(`Cleaned up ${deleted.length} expired contact outbox items`);
  }
  return deleted.length;
}
