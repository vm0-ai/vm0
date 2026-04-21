import { resendContactMapping } from "../../db/schema/resend-contact-mapping";
import { resendContactOutbox } from "../../db/schema/resend-contact-outbox";
import { initServices } from "../../lib/init-services";

/**
 * Insert a raw Resend contact mapping row for test setup.
 *
 * @why-db-direct No API route writes this table directly; it is populated
 * internally by the drain cron after a successful Resend Contacts API call.
 */
export async function insertTestContactMapping(values: {
  clerkUserId: string;
  resendContactId: string;
  lastEmail: string;
  lastFirstName?: string | null;
  lastLastName?: string | null;
}): Promise<void> {
  initServices();
  await globalThis.services.db.insert(resendContactMapping).values({
    clerkUserId: values.clerkUserId,
    resendContactId: values.resendContactId,
    lastEmail: values.lastEmail,
    lastFirstName: values.lastFirstName ?? null,
    lastLastName: values.lastLastName ?? null,
  });
}

/**
 * Insert a raw Resend contact outbox row for test setup.
 *
 * @why-db-direct Bypasses enqueueContactOps() to let tests seed specific
 * op/status/attempts combinations that the reconcile cron would otherwise
 * derive from live Clerk data.
 */
export async function insertTestContactOutboxItem(values: {
  op: "create" | "update" | "delete";
  clerkUserId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  status?: string;
}): Promise<{ id: string }> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(resendContactOutbox)
    .values({
      op: values.op,
      clerkUserId: values.clerkUserId,
      email: values.email ?? null,
      firstName: values.firstName ?? null,
      lastName: values.lastName ?? null,
      status: values.status ?? "pending",
    })
    .returning({ id: resendContactOutbox.id });
  return row!;
}

/**
 * Clear contact outbox rows whose clerkUserId starts with the given prefix.
 *
 * @why-db-direct Used by test beforeEach to isolate a test file's rows from
 * stale state left by prior tests in the same file. Scoped by prefix so
 * parallel test files with different prefixes are unaffected.
 */
export async function clearTestContactOutboxByPrefix(
  prefix: string,
): Promise<void> {
  initServices();
  const { like } = await import("drizzle-orm");
  await globalThis.services.db
    .delete(resendContactOutbox)
    .where(like(resendContactOutbox.clerkUserId, `${prefix}%`));
}

export async function clearTestContactMappingByPrefix(
  prefix: string,
): Promise<void> {
  initServices();
  const { like } = await import("drizzle-orm");
  await globalThis.services.db
    .delete(resendContactMapping)
    .where(like(resendContactMapping.clerkUserId, `${prefix}%`));
}
