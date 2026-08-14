/** OpenAI-compatible providers Pi can drive through the VM0 firewall. */
export const PI_OPENAI_COMPATIBLE_PROVIDERS = [
  "deepseek",
  "moonshotai",
  "openai",
  "openrouter",
  "vercel-ai-gateway",
  "codex",
] as const;

export type PiOpenAICompatibleProvider =
  (typeof PI_OPENAI_COMPATIBLE_PROVIDERS)[number];

/** Model endpoint and credential resolved inside the Pi sandbox process. */
export interface PiAgentModelConfig {
  readonly provider: PiOpenAICompatibleProvider;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}
