import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { and, eq, or } from "drizzle-orm";

import { badRequestMessage } from "../../lib/error";
import type { Db } from "../external/db";
import { ensureOrgModelPolicies } from "./zero-model-policy.service";
import { checkOrgCreditsForRunAdmission } from "./zero-run-admission.service";

const ORG_SENTINEL_USER_ID = "__org__";
export const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

export interface ModelFirstPin {
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

interface ModelSelectionRequest {
  readonly modelProviderId: string;
  readonly selectedModel: string;
}

function parseModelProviderCredentialScope(
  value: string | null,
): ModelProviderCredentialScope | null {
  if (value === null || value === "org" || value === "member") {
    return value;
  }
  throw new Error(`Unknown model provider credential scope "${value}"`);
}

export function modelOnlyModelFirstPin(
  selectedModel: string | null,
): ModelFirstPin {
  return {
    modelProviderId: null,
    modelProviderType: null,
    modelProviderCredentialScope: null,
    selectedModel,
  };
}

export async function resolveDefaultModelFirstPin(
  db: Db,
  orgId: string,
  userId: string,
): Promise<ModelFirstPin> {
  const [preference] = await db
    .select({ selectedModel: orgMembersMetadata.selectedModel })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);

  const preferredModel = preference?.selectedModel ?? null;
  const [policy] = await db
    .select({
      model: orgModelPolicies.model,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
    })
    .from(orgModelPolicies)
    .where(
      preferredModel
        ? and(
            eq(orgModelPolicies.orgId, orgId),
            eq(orgModelPolicies.model, preferredModel),
          )
        : and(
            eq(orgModelPolicies.orgId, orgId),
            eq(orgModelPolicies.isDefault, true),
          ),
    )
    .limit(1);

  if (!policy && preferredModel) {
    return resolveDefaultModelFirstPin(db, orgId, "__no_preference__");
  }

  if (!policy) {
    return {
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: null,
    };
  }

  return {
    modelProviderId: policy.modelProviderId ?? null,
    modelProviderType: policy.defaultProviderType,
    modelProviderCredentialScope: parseModelProviderCredentialScope(
      policy.credentialScope,
    ),
    selectedModel: policy.model,
  };
}

export async function modelProviderPinAvailable(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId: string;
}): Promise<boolean> {
  const [provider] = await params.db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.id, params.modelProviderId),
        eq(modelProviders.orgId, params.orgId),
        or(
          eq(modelProviders.userId, params.userId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      ),
    )
    .limit(1);
  return provider !== undefined;
}

export async function resolveModelSelectionPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelSelection: ModelSelectionRequest;
}): Promise<ModelFirstPin | ReturnType<typeof badRequestMessage>> {
  const { db, orgId, userId, modelSelection } = params;
  if (modelSelection.modelProviderId !== MODEL_FIRST_SELECTION_PROVIDER_ID) {
    const available = await modelProviderPinAvailable({
      db,
      orgId,
      userId,
      modelProviderId: modelSelection.modelProviderId,
    });
    if (!available) {
      return badRequestMessage("Unknown model provider for this workspace");
    }
    return {
      modelProviderId: modelSelection.modelProviderId,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: modelSelection.selectedModel,
    };
  }

  await ensureOrgModelPolicies(db, orgId, userId);
  const [policy] = await db
    .select({
      model: orgModelPolicies.model,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
    })
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, orgId),
        eq(orgModelPolicies.model, modelSelection.selectedModel),
      ),
    )
    .limit(1);
  if (!policy) {
    return {
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: modelSelection.selectedModel,
    };
  }
  return {
    modelProviderId: policy.modelProviderId ?? null,
    modelProviderType: policy.defaultProviderType,
    modelProviderCredentialScope: parseModelProviderCredentialScope(
      policy.credentialScope,
    ),
    selectedModel: policy.model,
  };
}

async function resolveEffectiveModelProviderType(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelPin: ModelFirstPin;
  readonly requestedModelProvider: string | undefined;
}): Promise<string | null | undefined> {
  if (params.modelPin.modelProviderType) {
    return params.modelPin.modelProviderType;
  }
  if (!params.modelPin.modelProviderId) {
    return params.requestedModelProvider;
  }

  const [provider] = await params.db
    .select({ type: modelProviders.type })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.id, params.modelPin.modelProviderId),
        eq(modelProviders.orgId, params.orgId),
        or(
          eq(modelProviders.userId, params.userId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      ),
    )
    .limit(1);

  return provider?.type ?? params.requestedModelProvider;
}

export async function resolveModelFirstProviderAdmission(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelPin: ModelFirstPin;
  readonly requestedModelProvider: string | undefined;
}): Promise<{
  readonly effectiveModelProvider: string | null | undefined;
  readonly error: Awaited<ReturnType<typeof checkOrgCreditsForRunAdmission>>;
}> {
  const effectiveModelProvider =
    await resolveEffectiveModelProviderType(params);
  const error = await checkOrgCreditsForRunAdmission({
    db: params.db,
    orgId: params.orgId,
    modelProviderType: effectiveModelProvider,
  });
  return { effectiveModelProvider, error };
}
