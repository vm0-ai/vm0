import { and, eq } from "drizzle-orm";
import {
  isSupportedRunModel,
  normalizeRunModelId,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import { badRequest } from "@vm0/api-services/errors";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { ensureOrgModelPolicies } from "./org-model-policy-service";

interface UserModelPreference {
  selectedModel: SupportedRunModel | null;
  updatedAt: Date | null;
}

function canonicalizeRunModel(model: string): SupportedRunModel {
  const canonical = normalizeRunModelId(model);
  if (isSupportedRunModel(canonical)) {
    return canonical;
  }
  throw badRequest(`Unknown model "${model}"`);
}

async function assertModelConfigured(
  orgId: string,
  selectedModel: SupportedRunModel,
): Promise<void> {
  const policies = await ensureOrgModelPolicies(orgId);
  const configured = policies.some((policy) => {
    return policy.model === selectedModel;
  });
  if (!configured) {
    throw badRequest(
      `Model "${selectedModel}" is not configured for this workspace`,
    );
  }
}

async function getUserModelPreference(
  orgId: string,
  userId: string,
): Promise<UserModelPreference> {
  const [row] = await globalThis.services.db
    .select({
      model: orgMembersMetadata.selectedModel,
      updatedAt: orgMembersMetadata.updatedAt,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);

  if (!row?.model) {
    return { selectedModel: null, updatedAt: null };
  }

  const canonical = normalizeRunModelId(row.model);
  const selectedModel = isSupportedRunModel(canonical) ? canonical : null;
  return {
    selectedModel,
    updatedAt: selectedModel ? row.updatedAt : null,
  };
}

export async function getUserModelPreferenceModel(
  orgId: string,
  userId: string,
): Promise<SupportedRunModel | null> {
  return (await getUserModelPreference(orgId, userId)).selectedModel;
}

export async function updateUserModelPreference(
  orgId: string,
  userId: string,
  selectedModel: string | null,
): Promise<UserModelPreference> {
  if (selectedModel === null) {
    await globalThis.services.db
      .update(orgMembersMetadata)
      .set({ selectedModel: null, updatedAt: new Date() })
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      );
    return { selectedModel: null, updatedAt: null };
  }

  const model = canonicalizeRunModel(selectedModel);
  await assertModelConfigured(orgId, model);

  const now = new Date();
  const [row] = await globalThis.services.db
    .insert(orgMembersMetadata)
    .values({
      orgId,
      userId,
      selectedModel: model,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        selectedModel: model,
        updatedAt: now,
      },
    })
    .returning({
      model: orgMembersMetadata.selectedModel,
      updatedAt: orgMembersMetadata.updatedAt,
    });

  return {
    selectedModel: row?.model ? canonicalizeRunModel(row.model) : model,
    updatedAt: row?.updatedAt ?? now,
  };
}
