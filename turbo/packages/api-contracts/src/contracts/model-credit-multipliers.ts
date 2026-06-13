/**
 * Canonical VM0-managed run models and Built-in credit multipliers.
 *
 * Keep this module lightweight so public UI surfaces can read multiplier data
 * without importing the full model provider contract schema.
 */
export const SUPPORTED_RUN_MODELS = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "deepseek-v4-pro",
  "kimi-k2.6",
  "kimi-k2.5",
  "MiniMax-M3",
  "glm-5.1",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
] as const;

export type SupportedRunModel = (typeof SUPPORTED_RUN_MODELS)[number];

/**
 * Credit multiplier for Built-in model offerings, normalized so Claude Sonnet
 * 4.6 = 1x. These are the platform display and billing multipliers, adjusted
 * for both vendor pricing and observed token consumption differences across
 * models on comparable tasks. Only applies to the `vm0` provider type; BYOK
 * providers pay the vendor directly and do not carry a platform multiplier.
 */
export const VM0_MODEL_CREDIT_MULTIPLIER = Object.freeze<
  Record<SupportedRunModel, number>
>({
  "claude-fable-5": 3.3,
  "claude-opus-4-8": 2,
  "claude-opus-4-7": 2,
  "claude-opus-4-6": 2,
  "claude-sonnet-4-6": 1,
  "deepseek-v4-pro": 0.1,
  "kimi-k2.6": 0.3,
  "kimi-k2.5": 0.2,
  "MiniMax-M3": 0.2,
  "glm-5.1": 0.4,
  "gpt-5.5": 2,
  "gpt-5.4": 1,
  "gpt-5.4-mini": 0.3,
});
