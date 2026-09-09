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

export type PiAgentServiceTier = "priority" | "fast";

export type PiAgentDialect =
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "bedrock-converse-stream";

export type PiAgentTransport = "sse" | "aws-event-stream";

export type PiAgentCredentialTarget = "direct" | "sandbox-firewall";

export type PiAgentRequestHeaders = Readonly<Record<string, string | null>>;

export interface PiAgentCredentialHeaderTemplate {
  readonly name: string;
  readonly valueTemplate: string;
}

export interface PiAgentCredentialReference {
  readonly kind:
    | "api-key"
    | "access-token"
    | "account-id"
    | "aws-bearer-token"
    | "aws-access-key-id"
    | "aws-secret-access-key"
    | "aws-session-token";
  readonly environment: string;
  readonly secretName: string;
  readonly credentialHeader?: PiAgentCredentialHeaderTemplate;
}

export type PiAgentBedrockAuth =
  | { readonly kind: "bearer"; readonly token: string }
  | {
      readonly kind: "sigv4";
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken?: string;
    };

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
  readonly dialect: PiAgentDialect;
  /** Explicit ChatGPT account identity required by the Codex dialect. */
  readonly accountId?: string;
  readonly region?: string;
  readonly bedrockAuth?: PiAgentBedrockAuth;
  /** Route-owned transport policy. Codex subscriptions are SSE-only. */
  readonly transport?: PiAgentTransport;
  /** Omitted by legacy launch payloads, which retain Pi's medium default. */
  readonly thinkingLevel?: PiAgentThinkingLevel;
  /**
   * Omitted by legacy and standard launches. Applied to every request in this
   * run.
   */
  readonly serviceTier?: PiAgentServiceTier;
}
