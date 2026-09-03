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

export type PiAgentDialect = "openai-responses" | "openai-codex-responses";

export type PiAgentTransport = "sse";

export type PiAgentCredentialTarget = "direct" | "sandbox-firewall";

export type PiAgentRequestHeaders = Readonly<Record<string, string | null>>;

export interface PiAgentCredentialHeaderTemplate {
  readonly name: string;
  readonly valueTemplate: string;
}

export interface PiAgentCredentialReference {
  readonly kind: "api-key" | "access-token" | "account-id";
  readonly environment: string;
  readonly secretName: string;
  readonly credentialHeader?: PiAgentCredentialHeaderTemplate;
}

/** Model endpoint and credential resolved at a Pi execution edge. */
export interface PiAgentModelConfig {
  /** Native provider identity used for trusted catalog metadata. */
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Provider model identifier sent with requests. */
  readonly model: string;
  /** Native catalog entry when the request model uses a gateway alias. */
  readonly catalogModel?: string;
  /** Execution-edge headers that override provider defaults case-insensitively. */
  readonly requestHeaders?: PiAgentRequestHeaders;
  /** Authoritative native adapter selected by the materialized route. */
  readonly dialect?: PiAgentDialect;
  /** Explicit ChatGPT account identity required by the Codex dialect. */
  readonly accountId?: string;
  /** Route-owned transport policy. Codex subscriptions are SSE-only. */
  readonly transport?: PiAgentTransport;
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
