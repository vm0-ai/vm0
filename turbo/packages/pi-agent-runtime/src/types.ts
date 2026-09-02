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
  /** Concrete provider identity used only for catalog metadata and requests. */
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /**
   * Deployment-compatibility input only. New writers emit
   * `openai-responses`; legacy values are ignored by the Responses-only
   * runtime.
   */
  readonly api?:
    | "openai-completions"
    | "openai-responses"
    | "openai-codex-responses";
  /** Omitted by legacy launch payloads, which retain Pi's medium default. */
  readonly thinkingLevel?: PiAgentThinkingLevel;
  /**
   * Omitted by legacy and standard launches. Applied to every request in this
   * run.
   */
  readonly serviceTier?: PiAgentServiceTier;
}
