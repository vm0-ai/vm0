import { command } from "ccstate";
import {
  getFrameworkForType,
  getVm0ConcreteProviderType,
  isBuiltInModelProviderType,
  isSupportedRunModel,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { SupportedFramework } from "@okouai/core/frameworks";

import { writeDb$ } from "../external/db";
import { resolveDefaultModelFirstPin } from "./model-selection.service";

export interface IntegrationModelRoutePin {
  readonly modelProviderType: string;
  readonly modelProviderId: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope;
  readonly selectedModel: string;
  readonly serviceTier: ChatThreadServiceTier | null;
  readonly cliAgentType: SupportedFramework;
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
    const pin = await resolveDefaultModelFirstPin(
      set(writeDb$),
      args.orgId,
      args.userId,
    );
    signal.throwIfAborted();
    const providerType = modelProviderTypeSchema.safeParse(
      pin.modelProviderType,
    );
    if (
      !providerType.success ||
      !pin.modelProviderCredentialScope ||
      !isSupportedRunModel(pin.selectedModel)
    ) {
      return undefined;
    }

    return {
      modelProviderType: providerType.data,
      modelProviderId: pin.modelProviderId,
      modelProviderCredentialScope: pin.modelProviderCredentialScope,
      selectedModel: pin.selectedModel,
      serviceTier: pin.serviceTier,
      cliAgentType: getFrameworkForType(
        isBuiltInModelProviderType(providerType.data)
          ? getVm0ConcreteProviderType(pin.selectedModel)
          : providerType.data,
      ),
    };
  },
);
