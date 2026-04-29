import { randomUUID } from "node:crypto";

import type { Store } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface AutoRechargeOrgFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface AutoRechargeSeedValues {
  readonly enabled?: boolean;
  readonly threshold?: number | null;
  readonly amount?: number | null;
}

export async function seedAutoRechargeOrg(
  store: Store,
  values: AutoRechargeSeedValues = {},
): Promise<AutoRechargeOrgFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const writeDb = store.set(writeDb$);

  await writeDb.insert(orgMetadata).values({
    orgId,
    autoRechargeEnabled: values.enabled ?? false,
    autoRechargeThreshold: values.threshold ?? null,
    autoRechargeAmount: values.amount ?? null,
  });

  return { orgId, userId };
}

export async function deleteAutoRechargeOrg(
  store: Store,
  fixture: AutoRechargeOrgFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
}
