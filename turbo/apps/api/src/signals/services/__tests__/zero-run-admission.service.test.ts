import { randomUUID } from "node:crypto";

import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { createStore } from "ccstate";
import { like } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { resolveOrgCreditAvailability } from "../zero-run-admission.service";

const store = createStore();
const ORG_ID_PREFIX = "org_zero_run_admission_";

afterEach(async () => {
  const db = store.set(writeDb$);
  await db
    .delete(creditExpiresRecord)
    .where(like(creditExpiresRecord.orgId, `${ORG_ID_PREFIX}%`));
  await db
    .delete(orgMetadata)
    .where(like(orgMetadata.orgId, `${ORG_ID_PREFIX}%`));
});

async function withCreditFixture<T>(
  fn: (fixture: { readonly orgId: string }) => Promise<T>,
): Promise<T> {
  const orgId = `${ORG_ID_PREFIX}${randomUUID()}`;
  const db = store.set(writeDb$);

  await db.insert(orgMetadata).values({
    orgId,
    tier: "free",
    credits: 10_000,
  });

  return await fn({ orgId });
}

describe("resolveOrgCreditAvailability", () => {
  it("returns spendable credits after unsettled expired credits", async () => {
    await withCreditFixture(async ({ orgId }) => {
      const db = store.set(writeDb$);
      await db.insert(creditExpiresRecord).values({
        orgId,
        source: "subscription_renewal",
        amount: 2500,
        remaining: 2500,
        expiresAt: new Date(now() - 24 * 60 * 60 * 1000),
      });

      await expect(
        resolveOrgCreditAvailability({ db, orgId }),
      ).resolves.toStrictEqual({ tier: "free", spendableCredits: 7500 });
    });
  });
});
