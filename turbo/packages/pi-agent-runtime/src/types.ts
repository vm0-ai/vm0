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
   * Cross-version input only. New writers emit `openai-responses`; the runtime
   * ignores absent or legacy values. Remove with #31085 after the previous API
   * leaves the rollback window, the two-hour runner/Sandbox drain plus
   * finalization completes, and no executable pre-cutover contexts remain.
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
