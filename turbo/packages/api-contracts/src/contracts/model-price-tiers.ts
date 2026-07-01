/**
 * Canonical VM0-managed run models and Built-in credit price tiers.
 *
 * Keep this module lightweight so public UI surfaces can read price tier data
 * without importing the full model provider contract schema.
 */
export const SUPPORTED_RUN_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "deepseek-v4-pro",
  "kimi-k2.7-code",
  "MiniMax-M3",
  "glm-5.2",
  "glm-5.1",
  "mimo-v2.5",
  "hy3-preview",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
] as const;

export type SupportedRunModel = (typeof SUPPORTED_RUN_MODELS)[number];

export type Vm0ModelPriceTier = "$" | "$$" | "$$$";

/**
 * User-facing credit cost tier for Built-in model offerings. Only applies to
 * the `vm0` provider type; BYOK providers pay the vendor directly and do not
 * carry a platform tier.
 */
export const VM0_MODEL_PRICE_TIER = Object.freeze<
  Record<SupportedRunModel, Vm0ModelPriceTier>
>({
  "claude-opus-4-8": "$$$",
  "claude-opus-4-7": "$$$",
  "claude-opus-4-6": "$$$",
  "claude-sonnet-5": "$$",
  "claude-sonnet-4-6": "$$",
  "deepseek-v4-pro": "$",
  "kimi-k2.7-code": "$",
  "MiniMax-M3": "$",
  "glm-5.2": "$",
  "glm-5.1": "$",
  "mimo-v2.5": "$",
  "hy3-preview": "$",
  "gpt-5.5": "$$$",
  "gpt-5.4": "$$",
  "gpt-5.4-mini": "$",
});

export const VM0_MODEL_PRICE_TIER_LABEL = Object.freeze<
  Record<Vm0ModelPriceTier, string>
>({
  $: "Economy tier for everyday simple tasks",
  $$: "Balanced cost and performance",
  $$$: "Frontier flagship model",
});
