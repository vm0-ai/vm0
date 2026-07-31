import {
  MODEL_PROVIDER_TYPES,
  getVm0ModelPriceTier,
  type ModelProviderType,
  type SupportedRunModel,
  type Vm0ModelPriceTier,
} from "@vm0/api-contracts/contracts/model-providers";
import { i18n } from "../../../../i18n/index.ts";

/**
 * Get the display label for a provider type (UI override or core fallback)
 */
export function getUILabel(type: ModelProviderType): string {
  switch (type) {
    case "vm0": {
      return i18n.t(($) => {
        return $.settings.models.picker.builtInModel;
      });
    }
    case "claude-code-oauth-token": {
      return i18n.t(($) => {
        return $.settings.models.picker.providerLabels.claudeCodeOauth;
      });
    }
    case "deepseek-api-key":
    case "deepseek-codex": {
      return i18n.t(($) => {
        return $.settings.models.picker.providerLabels.deepseek;
      });
    }
    case "azure-foundry": {
      return i18n.t(($) => {
        return $.settings.models.picker.providerLabels.azureFoundryPortal;
      });
    }
    default: {
      return MODEL_PROVIDER_TYPES[type].label;
    }
  }
}

export function getVm0ModelPriceTierLabel(tier: Vm0ModelPriceTier): string {
  switch (tier) {
    case "$": {
      return i18n.t(($) => {
        return $.settings.models.picker.priceTiers.economy;
      });
    }
    case "$$": {
      return i18n.t(($) => {
        return $.settings.models.picker.priceTiers.balanced;
      });
    }
    case "$$$": {
      return i18n.t(($) => {
        return $.settings.models.picker.priceTiers.frontier;
      });
    }
    case "$$$$": {
      return i18n.t(($) => {
        return $.settings.models.picker.priceTiers.premium;
      });
    }
  }
}

const MODEL_BRAND_ICON: Readonly<Record<SupportedRunModel, ModelProviderType>> =
  Object.freeze({
    "claude-fable-5": "anthropic-api-key",
    "claude-opus-5": "anthropic-api-key",
    "claude-opus-4-8": "anthropic-api-key",
    "claude-opus-4-7": "anthropic-api-key",
    "claude-opus-4-6": "anthropic-api-key",
    "claude-sonnet-5": "anthropic-api-key",
    "claude-sonnet-4-6": "anthropic-api-key",
    "deepseek-v4-pro": "deepseek-api-key",
    "deepseek-v4-flash": "deepseek-codex",
    "kimi-k3": "moonshot-api-key",
    "kimi-k2.7-code": "moonshot-api-key",
    "MiniMax-M3": "minimax-api-key",
    "glm-5.2": "zai-api-key",
    "glm-5.1": "zai-api-key",
    "mimo-v2.5": "openrouter-api-key",
    "hy3-preview": "openrouter-api-key",
    "gpt-5.6-sol": "openai-api-key",
    "gpt-5.6-terra": "openai-api-key",
    "gpt-5.6-luna": "openai-api-key",
    "gpt-5.5": "openai-api-key",
  });

export function getModelBrandIconType(
  model: SupportedRunModel,
): ModelProviderType {
  return MODEL_BRAND_ICON[model];
}
export { getVm0ModelPriceTier, type Vm0ModelPriceTier };
