/**
 * In-process test fixture for `org_metadata` tier and credit balance.
 *
 * The tier/credit combinations the generation tests exercise cannot be
 * constructed through product APIs: the Stripe webhook path only produces
 * "pro"/"team" orgs with fixed subscription credit grants, "limited-free-1"
 * is only set by the Clerk org-creation bootstrap (which also provisions a
 * default agent/compose), and the legacy "free" tier — still present in
 * production data and load-bearing for voice-io quota limits — has no
 * creation path at all. Exact credit balances (e.g. 0 or 1000) are equally
 * unreachable because product grants come in fixed subscription amounts.
 * This module is the narrow test-boundary exception: it only upserts an
 * org's tier and credit balance.
 */
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { createStore } from "ccstate";
import { sql } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

export async function upsertOrgMetadataFixture(values: {
  readonly orgId: string;
  readonly tier: string;
  readonly credits: number;
}): Promise<void> {
  await createStore()
    .set(writeDb$)
    .insert(orgMetadata)
    .values(values)
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: {
        tier: values.tier,
        credits: values.credits,
        updatedAt: sql`now()`,
      },
    });
}
