import { command } from "ccstate";
import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";

import { writeDb$ } from "../external/db";
import { resolveDefaultModelFirstPin } from "./zero-model-selection.service";
import { ensureOrgModelPolicies } from "./zero-model-policy.service";

export interface IntegrationModelRoutePin {
  readonly modelProviderType: string;
  readonly modelProviderId: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope;
  readonly selectedModel: string;
}

export const resolveIntegrationModelRouteForUser$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<IntegrationModelRoutePin | undefined> => {
    const db = set(writeDb$);
    await ensureOrgModelPolicies(db, args.orgId, args.userId);
    signal.throwIfAborted();
    const pin = await resolveDefaultModelFirstPin(db, args.orgId, args.userId);
    signal.throwIfAborted();
    if (
      !pin.selectedModel ||
      !pin.modelProviderType ||
      !pin.modelProviderCredentialScope
    ) {
      return undefined;
    }

    return {
      modelProviderType: pin.modelProviderType,
      modelProviderId: pin.modelProviderId,
      modelProviderCredentialScope: pin.modelProviderCredentialScope,
      selectedModel: pin.selectedModel,
    };
  },
);
