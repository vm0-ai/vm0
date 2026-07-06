import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";

import type { Db } from "../external/db";
import {
  resolveDefaultModelFirstPin,
  type ModelFirstPin,
} from "./zero-model-selection.service";

export function chatThreadModelPinColumns(pin: ModelFirstPin): {
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
} {
  return {
    modelProviderId: pin.modelProviderId,
    modelProviderType: pin.modelProviderType,
    modelProviderCredentialScope: pin.modelProviderCredentialScope,
    selectedModel: pin.selectedModel,
  };
}

export async function resolveRequiredDefaultChatThreadModelPin(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<ModelFirstPin> {
  const pin = await resolveDefaultModelFirstPin(db, args.orgId, args.userId);
  if (!pin.selectedModel) {
    throw new Error("A model selection is required");
  }
  return pin;
}
