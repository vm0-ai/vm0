import {
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  MODEL_PROVIDER_FIREWALL_CONFIGS,
} from "../contracts/model-providers";
import {
  CANONICAL_GUEST_HOME_DIR,
  CANONICAL_WORKING_DIR,
  RESUME_SESSION_HISTORY_MAX_BYTES,
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
    rustModulePath: ["runners"],
    rustConstName: "RESUME_SESSION_HISTORY_MAX_BYTES",
    value: rustU64(RESUME_SESSION_HISTORY_MAX_BYTES),
    rustDoc: [
      "Maximum resume session history blob size accepted by the API and runner.",
      "Rust and TypeScript components use this shared contract value when validating resume history refs and downloads.",
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
