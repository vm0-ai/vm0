import { clerkClient } from "@clerk/nextjs/server";
import { resendContactMapping } from "../../../db/schema/resend-contact-mapping";
import {
  enqueueContactOps,
  type EnqueueContactOpInput,
} from "./contact-outbox-service";
import { logger } from "../../shared/logger";

const log = logger("resend-contacts:reconcile");

const CLERK_PAGE_LIMIT = 500;

interface ReconcileStats {
  clerkUsersScanned: number;
  created: number;
  updated: number;
  deleted: number;
}

interface ClerkSnapshot {
  clerkUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

async function fetchAllClerkUsers(): Promise<ClerkSnapshot[]> {
  const client = await clerkClient();
  const snapshots: ClerkSnapshot[] = [];
  let offset = 0;

  while (true) {
    const page = await client.users.getUserList({
      limit: CLERK_PAGE_LIMIT,
      offset,
    });
    for (const user of page.data) {
      const primary = user.emailAddresses.find((e) => {
        return e.id === user.primaryEmailAddressId;
      });
      if (!primary?.emailAddress) continue;

      snapshots.push({
        clerkUserId: user.id,
        email: primary.emailAddress,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
      });
    }

    if (page.data.length < CLERK_PAGE_LIMIT) break;
    offset += CLERK_PAGE_LIMIT;
  }

  return snapshots;
}

export async function reconcileContacts(): Promise<ReconcileStats> {
  const clerkUsers = await fetchAllClerkUsers();

  const mappings = await globalThis.services.db
    .select({
      clerkUserId: resendContactMapping.clerkUserId,
      lastEmail: resendContactMapping.lastEmail,
      lastFirstName: resendContactMapping.lastFirstName,
      lastLastName: resendContactMapping.lastLastName,
    })
    .from(resendContactMapping);

  const mappingByUser = new Map(
    mappings.map((m) => {
      return [m.clerkUserId, m];
    }),
  );
  const clerkUserIds = new Set(
    clerkUsers.map((u) => {
      return u.clerkUserId;
    }),
  );

  const ops: EnqueueContactOpInput[] = [];

  for (const user of clerkUsers) {
    const mapping = mappingByUser.get(user.clerkUserId);
    if (!mapping) {
      ops.push({
        op: "create",
        clerkUserId: user.clerkUserId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      });
      continue;
    }

    if (
      mapping.lastEmail !== user.email ||
      mapping.lastFirstName !== user.firstName ||
      mapping.lastLastName !== user.lastName
    ) {
      ops.push({
        op: "update",
        clerkUserId: user.clerkUserId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      });
    }
  }

  for (const mapping of mappings) {
    if (!clerkUserIds.has(mapping.clerkUserId)) {
      ops.push({
        op: "delete",
        clerkUserId: mapping.clerkUserId,
      });
    }
  }

  await enqueueContactOps(ops);

  const stats: ReconcileStats = {
    clerkUsersScanned: clerkUsers.length,
    created: ops.filter((o) => {
      return o.op === "create";
    }).length,
    updated: ops.filter((o) => {
      return o.op === "update";
    }).length,
    deleted: ops.filter((o) => {
      return o.op === "delete";
    }).length,
  };

  if (stats.created > 0 || stats.updated > 0 || stats.deleted > 0) {
    log.debug("Reconcile enqueued contact ops", stats);
  }

  return stats;
}
