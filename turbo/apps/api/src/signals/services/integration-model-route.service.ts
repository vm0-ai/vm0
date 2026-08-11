import { command } from "ccstate";
import {
  getFrameworkForType,
  getVm0ConcreteProviderType,
  isSupportedRunModel,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
} from "@vm0/api-contracts/contracts/model-providers";
import type { ChatThreadServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
import type { SupportedFramework } from "@vm0/core/frameworks";

import { writeDb$ } from "../external/db";
import { resolveDefaultModelFirstPin } from "./zero-model-selection.service";

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
        providerType.data === "vm0"
          ? getVm0ConcreteProviderType(pin.selectedModel)
          : providerType.data,
      ),
    };
  },
);
