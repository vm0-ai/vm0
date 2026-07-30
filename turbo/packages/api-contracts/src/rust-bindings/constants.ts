import {
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  MODEL_PROVIDER_FIREWALL_CONFIGS,
} from "../contracts/model-providers";
import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_APP,
  CLIENT_TYPE_CLI,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_GUEST_AGENT,
  CLIENT_TYPE_HEADER,
  CLIENT_TYPE_MITM_ADDON,
  CLIENT_TYPE_RUNNER,
  CLIENT_VERSION_HEADER,
} from "../contracts/client-headers";
import {
  CANONICAL_GUEST_HOME_DIR,
  CANONICAL_WORKING_DIR,
  NETWORK_POLICY_REFRESH_CONNECTOR_SLUGS_MAX,
  NETWORK_POLICY_REFRESH_RUN_TERMINAL_ERROR_CODE,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  RUNNER_POLL_EXCLUDED_RUN_IDS_MAX,
  SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
  SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
  SESSION_HISTORY_GZIP_MIN_BYTES,
} from "../contracts/runners";

export type RustConstantValue =
  | {
      readonly kind: "string";
      readonly value: string;
    }
  | {
      readonly kind: "u64";
      readonly value: number;
    };

export interface RustConstantBinding {
  readonly rustModulePath: readonly string[];
  readonly rustConstName: string;
  readonly value: RustConstantValue;
  readonly rustDoc: readonly string[];
}

export interface RustConstantModuleDoc {
  readonly rustModulePath: readonly string[];
  readonly rustDoc: readonly string[];
}

const codexOauthPlaceholderNames = [
  "CHATGPT_ACCESS_TOKEN",
  "CHATGPT_ACCOUNT_ID",
  "CHATGPT_REFRESH_TOKEN",
] as const;

type CodexOauthPlaceholderName = (typeof codexOauthPlaceholderNames)[number];

const modelProviderEnvPlaceholderNames = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CHATGPT_ACCESS_TOKEN",
  "CHATGPT_ACCOUNT_ID",
  "CHATGPT_REFRESH_TOKEN",
] as const;

type ModelProviderEnvPlaceholderName =
  (typeof modelProviderEnvPlaceholderNames)[number];

const codexOauthPlaceholderModule = [
  "codex_oauth_token",
  "placeholders",
] as const;

const modelProviderEnvPlaceholderModule = [
  "model_provider_env",
  "placeholders",
] as const;
const clientHeadersModule = ["client", "headers"] as const;
const clientTypesModule = ["client", "types"] as const;
const runnerPathsModule = ["runners", "paths"] as const;

export const rustConstantRootDoc = [
  "Generated Rust constants for `@vm0/api-contracts`.",
  "Do not edit by hand; regenerate with `cd turbo && pnpm -F @vm0/api-contracts generate:rust`.",
  "These constants are shared TypeScript/Rust contract values.",
  "Token-shaped placeholder values in this module are fake marker bytes, not secrets.",
] as const;

export const rustConstantModuleDocs = [
  {
    rustModulePath: ["codex_oauth_token"],
    rustDoc: [
      "Codex OAuth token contract constants shared by TypeScript and Rust.",
    ],
  },
  {
    rustModulePath: codexOauthPlaceholderModule,
    rustDoc: [
      "Fake Codex OAuth token placeholder marker values.",
      "These values are not secrets and are not usable credentials.",
    ],
  },
  {
    rustModulePath: ["model_provider_env"],
    rustDoc: [
      "Model-provider environment contract constants shared by TypeScript and Rust.",
    ],
  },
  {
    rustModulePath: modelProviderEnvPlaceholderModule,
    rustDoc: [
      "Fake model-provider environment placeholder marker values.",
      "These values are not secrets and are not usable credentials.",
    ],
  },
  {
    rustModulePath: ["client"],
    rustDoc: [
      "Client request contract constants shared by TypeScript and Rust.",
    ],
  },
  {
    rustModulePath: clientHeadersModule,
    rustDoc: [
      "HTTP header names used to identify vm0 clients in API request logs.",
    ],
  },
  {
    rustModulePath: clientTypesModule,
    rustDoc: [
      "Client type values used to identify vm0 API request originators.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustDoc: ["Runner contract constants shared by TypeScript and Rust."],
  },
  {
    rustModulePath: runnerPathsModule,
    rustDoc: [
      "Runner and guest filesystem path constants shared across Rust and TypeScript.",
    ],
  },
] satisfies readonly RustConstantModuleDoc[];

function codexOauthPlaceholder(name: CodexOauthPlaceholderName): string {
  const value =
    MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"].placeholders?.[name];
  if (value === undefined) {
    throw new Error(
      `codex-oauth-token firewall placeholder is missing ${name}`,
    );
  }
  if (value.length === 0) {
    throw new Error(`codex-oauth-token firewall placeholder ${name} is empty`);
  }
  return value;
}

function modelProviderEnvPlaceholder(
  name: ModelProviderEnvPlaceholderName,
): string {
  const value = MODEL_PROVIDER_ENV_PLACEHOLDERS[name];
  if (value.length === 0) {
    throw new Error(`model provider env placeholder ${name} is empty`);
  }
  return value;
}

function placeholderRustDoc(name: string): readonly string[] {
  return [
    `Fake marker bytes for the \`${name}\` placeholder.`,
    "This value is not a secret and must not be treated as a usable credential.",
  ];
}

function rustString(value: string): RustConstantValue {
  return { kind: "string", value };
}

function rustU64(value: number): RustConstantValue {
  return { kind: "u64", value };
}

export const rustConstantBindings = [
  {
    rustModulePath: clientHeadersModule,
    rustConstName: "CLIENT_VERSION_HEADER",
    value: rustString(CLIENT_VERSION_HEADER),
    rustDoc: ["HTTP header carrying the sending vm0 client component version."],
  },
  {
    rustModulePath: clientHeadersModule,
    rustConstName: "CLIENT_TYPE_HEADER",
    value: rustString(CLIENT_TYPE_HEADER),
    rustDoc: ["HTTP header carrying the sending vm0 client component type."],
  },
  {
    rustModulePath: clientHeadersModule,
    rustConstName: "CLIENT_SESSION_ID_HEADER",
    value: rustString(CLIENT_SESSION_ID_HEADER),
    rustDoc: [
      "HTTP header carrying the sending vm0 client session identifier.",
    ],
  },
  {
    rustModulePath: clientHeadersModule,
    rustConstName: "CLIENT_REQUEST_ID_HEADER",
    value: rustString(CLIENT_REQUEST_ID_HEADER),
    rustDoc: [
      "HTTP header carrying the per-request vm0 client request identifier.",
    ],
  },
  {
    rustModulePath: clientTypesModule,
    rustConstName: "CLIENT_TYPE_APP",
    value: rustString(CLIENT_TYPE_APP),
    rustDoc: ["Client type value for the platform web app."],
  },
  {
    rustModulePath: clientTypesModule,
    rustConstName: "CLIENT_TYPE_CLI",
    value: rustString(CLIENT_TYPE_CLI),
    rustDoc: ["Client type value for the CLI."],
  },
  {
    rustModulePath: clientTypesModule,
    rustConstName: "CLIENT_TYPE_DESKTOP",
    value: rustString(CLIENT_TYPE_DESKTOP),
    rustDoc: ["Client type value for the desktop client."],
  },
  {
    rustModulePath: clientTypesModule,
    rustConstName: "CLIENT_TYPE_GUEST_AGENT",
    value: rustString(CLIENT_TYPE_GUEST_AGENT),
    rustDoc: ["Client type value for the guest agent."],
  },
  {
    rustModulePath: clientTypesModule,
    rustConstName: "CLIENT_TYPE_MITM_ADDON",
    value: rustString(CLIENT_TYPE_MITM_ADDON),
    rustDoc: ["Client type value for the mitmproxy addon."],
  },
  {
    rustModulePath: clientTypesModule,
    rustConstName: "CLIENT_TYPE_RUNNER",
    value: rustString(CLIENT_TYPE_RUNNER),
    rustDoc: ["Client type value for the runner."],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "NETWORK_POLICY_REFRESH_CONNECTOR_SLUGS_MAX",
    value: rustU64(NETWORK_POLICY_REFRESH_CONNECTOR_SLUGS_MAX),
    rustDoc: [
      "Maximum connector slugs accepted by the runner network policy refresh endpoint.",
      "Rust runners use this shared contract value to split refresh requests before calling the API.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "NETWORK_POLICY_REFRESH_RUN_TERMINAL_ERROR_CODE",
    value: rustString(NETWORK_POLICY_REFRESH_RUN_TERMINAL_ERROR_CODE),
    rustDoc: [
      "API error code returned when network policy refresh targets a terminal run.",
      "Rust runners use this shared contract value to distinguish terminal reconciliation from ambiguous refresh failures.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "RESUME_SESSION_HISTORY_MAX_BYTES",
    value: rustU64(RESUME_SESSION_HISTORY_MAX_BYTES),
    rustDoc: [
      "Maximum resume session history blob size accepted by the API, runner, and guest verifier.",
      "Rust and TypeScript components use this shared contract value when validating resume history refs, downloads, and idle-reuse verification.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "RUNNER_POLL_EXCLUDED_RUN_IDS_MAX",
    value: rustU64(RUNNER_POLL_EXCLUDED_RUN_IDS_MAX),
    rustDoc: [
      "Maximum runner-local claim cooldown exclusions accepted by the poll endpoint.",
      "Rust runners use this shared contract value to bound local cooldown state and poll request size.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_ENCODING_GZIP",
    value: rustString(SESSION_HISTORY_ENCODING_GZIP),
    rustDoc: [
      "Wire and blob metadata value for gzip-compressed resume session history.",
      "Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_ENCODING_IDENTITY",
    value: rustString(SESSION_HISTORY_ENCODING_IDENTITY),
    rustDoc: [
      "Wire and blob metadata value for uncompressed resume session history.",
      "Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_ENCODING_ZSTD",
    value: rustString(SESSION_HISTORY_ENCODING_ZSTD),
    rustDoc: [
      "Wire and blob metadata value for zstd-compressed resume session history.",
      "Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT",
    value: rustString(
      SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
    ),
    rustDoc: [
      "Telemetry value for session history downloads signed with a configured S3 endpoint.",
      "Rust and TypeScript components use this shared contract value when attributing runner download latency.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT",
    value: rustString(SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT),
    rustDoc: [
      "Telemetry value for session history downloads signed with the default R2 endpoint.",
      "Rust and TypeScript components use this shared contract value when attributing runner download latency.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_GZIP_MIN_BYTES",
    value: rustU64(SESSION_HISTORY_GZIP_MIN_BYTES),
    rustDoc: [
      "Minimum raw resume session history size before the guest attempts gzip upload negotiation.",
      "Smaller histories stay identity-encoded to avoid gzip work when it cannot materially reduce transport size.",
    ],
  },
  {
    rustModulePath: runnerPathsModule,
    rustConstName: "CANONICAL_GUEST_HOME_DIR",
    value: rustString(CANONICAL_GUEST_HOME_DIR),
    rustDoc: [
      "Canonical home directory path expected for the sandbox user inside runner guests.",
      "Rust and TypeScript components use this shared contract value when building runner guest paths.",
    ],
  },
  {
    rustModulePath: runnerPathsModule,
    rustConstName: "CANONICAL_WORKING_DIR",
    value: rustString(CANONICAL_WORKING_DIR),
    rustDoc: [
      "Canonical working directory path expected inside runner guests.",
      "Rust and TypeScript components use this shared contract value when building runner commands and paths.",
    ],
  },
  ...codexOauthPlaceholderNames.map((name) => {
    return {
      rustModulePath: codexOauthPlaceholderModule,
      rustConstName: name,
      value: rustString(codexOauthPlaceholder(name)),
      rustDoc: placeholderRustDoc(name),
    };
  }),
  ...modelProviderEnvPlaceholderNames.map((name) => {
    return {
      rustModulePath: modelProviderEnvPlaceholderModule,
      rustConstName: name,
      value: rustString(modelProviderEnvPlaceholder(name)),
      rustDoc: placeholderRustDoc(name),
    };
  }),
] satisfies readonly RustConstantBinding[];
