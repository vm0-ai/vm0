import {
  MODEL_PROVIDER_TYPES,
  getVm0ModelPriceTier,
  getVm0ModelPriceTierLabel,
  type ModelProviderType,
  type SupportedRunModel,
  type Vm0ModelPriceTier,
} from "@vm0/api-contracts/contracts/model-providers";

/**
 * UI-only display overrides for provider labels. These do not modify the core
 * contracts, only how the platform UI renders them.
 */

interface ProviderUIOverrides {
  label?: string;
}

const PROVIDER_UI_OVERRIDES = Object.freeze<
  Partial<Record<ModelProviderType, ProviderUIOverrides>>
>({
  "claude-code-oauth-token": {
    label: "Claude Code (OAuth token)",
  },
  "deepseek-api-key": {
    label: "Deepseek",
  },
  "azure-foundry": {
    label: "Azure foundry portal",
  },
  vm0: {
    label: "Built-in model",
  },
});

function getOverrides(
  type: ModelProviderType,
): ProviderUIOverrides | undefined {
  return PROVIDER_UI_OVERRIDES[type];
}

/**
 * Get the display label for a provider type (UI override or core fallback)
 */
export function getUILabel(type: ModelProviderType): string {
  return getOverrides(type)?.label ?? MODEL_PROVIDER_TYPES[type].label;
}

const MODEL_BRAND_ICON: Readonly<Record<SupportedRunModel, ModelProviderType>> =
  Object.freeze({
    "claude-fable-5": "anthropic-api-key",
    "claude-opus-4-8": "anthropic-api-key",
    "claude-opus-4-7": "anthropic-api-key",
    "claude-opus-4-6": "anthropic-api-key",
    "claude-sonnet-5": "anthropic-api-key",
    "claude-sonnet-4-6": "anthropic-api-key",
    "deepseek-v4-pro": "deepseek-api-key",
    "kimi-k2.7-code": "moonshot-api-key",
    "MiniMax-M3": "minimax-api-key",
    "glm-5.2": "zai-api-key",
    "glm-5.1": "zai-api-key",
    "mimo-v2.5": "openrouter-api-key",
    "hy3-preview": "openrouter-api-key",
    "gpt-5.5": "openai-api-key",
    "gpt-5.4": "openai-api-key",
    "gpt-5.4-mini": "openai-api-key",
  });

export function getModelBrandIconType(
  model: SupportedRunModel,
): ModelProviderType {
  return MODEL_BRAND_ICON[model];
}
export {
  getVm0ModelPriceTier,
  getVm0ModelPriceTierLabel,
  type Vm0ModelPriceTier,
};
