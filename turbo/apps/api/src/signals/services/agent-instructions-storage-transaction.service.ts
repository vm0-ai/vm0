import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { storages } from "@okouai/db/schema/storage";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

export async function removeAgentInstructionsStorageInTransaction(
  tx: Tx,
  args: { readonly orgId: string; readonly agentName: string },
): Promise<string | null> {
  const storageName = getInstructionsStorageName(args.agentName);
  const [storage] = await tx
    .select({ id: storages.id, s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, storageName),
      ),
    )
    .limit(1);

  if (!storage) {
    return null;
  }

  await tx.delete(storages).where(eq(storages.id, storage.id));
  return storage.s3Prefix;
}
