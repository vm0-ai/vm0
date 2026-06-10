import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { orgMetadata } from "@vm0/db/schema/org-metadata";

import { writeDb$ } from "../../../external/db";

interface SeedOrgMetadataArgs {
  readonly orgId: string;
  readonly defaultAgentId?: string | null;
}

export const seedOrgMetadata$ = command(
  async (
    { set },
    args: SeedOrgMetadataArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .insert(orgMetadata)
      .values({
        orgId: args.orgId,
        defaultAgentId: args.defaultAgentId ?? null,
      })
      .onConflictDoUpdate({
        target: orgMetadata.orgId,
        set: { defaultAgentId: args.defaultAgentId ?? null },
      });
    signal.throwIfAborted();
  },
);

export const getOrgMetadataDefaultAgent$ = command(
  async (
    { set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    signal.throwIfAborted();
    return row?.defaultAgentId ?? null;
  },
);

export const deleteOrgMetadata$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
    signal.throwIfAborted();
  },
);
