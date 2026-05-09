import { and, eq, inArray } from "drizzle-orm";
import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  SUPPORTED_RUN_MODELS,
  getDefaultOrgModelPolicySeed,
  type SupportedRunModel,
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
    );
}

function getSupportedModelRank(model: string): number {
  const index = SUPPORTED_RUN_MODELS.indexOf(model as SupportedRunModel);
  return index === -1 ? SUPPORTED_RUN_MODELS.length : index;
}

function sortRowsByCatalog(rows: OrgModelPolicyRow[]): OrgModelPolicyRow[] {
  return [...rows].sort((a, b) => {
    return getSupportedModelRank(a.model) - getSupportedModelRank(b.model);
  });
}

export async function ensureOrgModelPolicies(
  orgId: string,
  userId?: string,
): Promise<OrgModelPolicyRow[]> {
  const existing = await loadRows(orgId);
  if (existing.length > 0) {
    if (
      existing.some((policy) => {
        return policy.isDefault;
      })
    ) {
      return sortRowsByCatalog(existing);
    }

    const fallbackDefault =
      existing.find((policy) => {
        return policy.model === DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
      }) ?? sortRowsByCatalog(existing)[0];
    if (fallbackDefault) {
      await globalThis.services.db
        .update(orgModelPolicies)
        .set({
          isDefault: true,
          updatedByUserId: userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(orgModelPolicies.id, fallbackDefault.id));
      return sortRowsByCatalog(await loadRows(orgId));
    }
    return sortRowsByCatalog(existing);
  }

  const existingModels = new Set(
    existing.map((policy) => {
      return policy.model;
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
        createdByUserId: userId ?? null,
        updatedByUserId: userId ?? null,
      };
    });

  if (missing.length === 0) {
    return sortRowsByCatalog(existing);
  }

  await globalThis.services.db
    .insert(orgModelPolicies)
    .values(missing)
    .onConflictDoNothing({
      target: [orgModelPolicies.orgId, orgModelPolicies.model],
    });

  return sortRowsByCatalog(await loadRows(orgId));
}
