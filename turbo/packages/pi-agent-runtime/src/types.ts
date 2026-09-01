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

export const PI_AGENT_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
] as const;

export type PiAgentApi = (typeof PI_AGENT_APIS)[number];

export const PI_AGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiAgentThinkingLevel = (typeof PI_AGENT_THINKING_LEVELS)[number];

export type PiAgentServiceTier = "priority";

/** Model endpoint and credential resolved inside the Pi sandbox process. */
export interface PiAgentModelConfig {
  readonly provider: PiOpenAICompatibleProvider;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** Omitted by legacy launch payloads, which retain the previous adapter behavior. */
  readonly api?: PiAgentApi;
  /** Omitted by legacy launch payloads, which retain Pi's medium default. */
  readonly thinkingLevel?: PiAgentThinkingLevel;
  /**
   * Omitted by legacy and standard launches. Applied to every request in this
   * run.
   */
  readonly serviceTier?: PiAgentServiceTier;
}
