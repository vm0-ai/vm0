import { and, asc, eq, inArray } from "drizzle-orm";
import {
  SUPPORTED_RUN_MODELS,
  getDefaultOrgModelPolicySeed,
} from "@vm0/api-contracts/contracts/model-providers";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";

type OrgModelPolicyRow = typeof orgModelPolicies.$inferSelect;

async function loadRows(orgId: string): Promise<OrgModelPolicyRow[]> {
  return globalThis.services.db
    .select()
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, orgId),
        inArray(orgModelPolicies.model, [...SUPPORTED_RUN_MODELS]),
      ),
    )
    .orderBy(asc(orgModelPolicies.sortOrder));
}

function nextAvailableSortOrder(
  preferred: number,
  usedSortOrders: Set<number>,
): number {
  let next = preferred;
  while (usedSortOrders.has(next)) {
    next += 1;
  }
  usedSortOrders.add(next);
  return next;
}

export async function ensureOrgModelPolicies(
  orgId: string,
  userId?: string,
): Promise<OrgModelPolicyRow[]> {
  const existing = await loadRows(orgId);
  if (existing.length > 0) {
    return existing;
  }

  const existingModels = new Set(
    existing.map((policy) => {
      return policy.model;
    }),
  );
  const usedSortOrders = new Set(
    existing.map((policy) => {
      return policy.sortOrder;
    }),
  );

  const missing = getDefaultOrgModelPolicySeed()
    .filter((seed) => {
      return !existingModels.has(seed.model);
    })
    .map((seed) => {
      return {
        ...seed,
        orgId,
        sortOrder: nextAvailableSortOrder(seed.sortOrder, usedSortOrders),
        createdByUserId: userId ?? null,
        updatedByUserId: userId ?? null,
      };
    });

  if (missing.length === 0) {
    return existing;
  }

  await globalThis.services.db
    .insert(orgModelPolicies)
    .values(missing)
    .onConflictDoNothing({
      target: [orgModelPolicies.orgId, orgModelPolicies.model],
    });

  return loadRows(orgId);
}
