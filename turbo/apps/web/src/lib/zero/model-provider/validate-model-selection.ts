import { and, eq } from "drizzle-orm";
import {
  MODEL_PROVIDER_TYPES,
  allowsCustomModel,
  getModels,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { badRequest } from "@vm0/api-services/errors";

interface ModelSelectionInput {
  orgId: string;
  modelProviderId?: string | null;
  selectedModel?: string | null;
}

/**
 * Validate that a {modelProviderId, selectedModel} pair is internally consistent
 * and scoped to the given org.
 *
 * Rules:
 *   - modelProviderId (if non-null) must reference a row in this org.
 *   - If modelProviderId AND selectedModel are both non-null, the model must be
 *     in MODEL_PROVIDER_TYPES[type].models, or the provider must allow custom
 *     models.
 *   - A selectedModel without a paired modelProviderId is accepted; resolution
 *     happens at runtime via the agent/org default provider.
 */
export async function validateModelSelection({
  orgId,
  modelProviderId,
  selectedModel,
}: ModelSelectionInput): Promise<void> {
  if (!modelProviderId) return;

  const [provider] = await globalThis.services.db
    .select({ type: modelProviders.type })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.id, modelProviderId),
        eq(modelProviders.orgId, orgId),
      ),
    )
    .limit(1);

  if (!provider) {
    throw badRequest(
      `Model provider "${modelProviderId}" not found in this org`,
    );
  }

  if (!selectedModel) return;

  const type = provider.type as ModelProviderType;
  if (!(type in MODEL_PROVIDER_TYPES)) {
    throw badRequest(`Unknown model provider type "${provider.type}"`);
  }

  if (allowsCustomModel(type)) return;

  const available = getModels(type) ?? [];
  if (!available.includes(selectedModel)) {
    throw badRequest(
      `Model "${selectedModel}" is not available for provider type "${type}". Available: ${available.join(", ")}`,
    );
  }
}
