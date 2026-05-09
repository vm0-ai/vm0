import { command } from "ccstate";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

interface SeedOrgMembershipValues {
  readonly orgId: string;
  readonly userId: string;
  readonly slug?: string;
  readonly name?: string;
  readonly role?: "admin" | "member";
  readonly seedOrgCache?: boolean;
}

export interface OrgMembershipFixture {
  readonly orgId: string;
  readonly userId: string;
}

export const seedOrgMembership$ = command(
  async (
    { set },
    values: SeedOrgMembershipValues,
    signal: AbortSignal,
  ): Promise<OrgMembershipFixture> => {
    const writeDb = set(writeDb$);
    if (values.seedOrgCache !== false) {
      await writeDb.insert(orgCache).values({
        orgId: values.orgId,
        slug: values.slug ?? `org-${values.orgId.slice(-8)}`,
        name: values.name ?? "",
      });
      signal.throwIfAborted();
    }
    await writeDb.insert(orgMembersCache).values({
      orgId: values.orgId,
      userId: values.userId,
      role: values.role ?? "member",
    });
    signal.throwIfAborted();
    return { orgId: values.orgId, userId: values.userId };
  },
);

export const deleteOrgMembership$ = command(
  async (
    { set },
    fixture: OrgMembershipFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(orgMembersCache)
      .where(eq(orgMembersCache.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb.delete(orgCache).where(eq(orgCache.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);
