import {
  normalizeConstantBindings,
  renderRustConstants,
  type NormalizedConstantBinding,
} from "../generate";
import {
  type RustConstantModuleDoc,
  type RustConstantBinding,
  type RustConstantValue,
  rustConstantBindings,
} from "../constants";
import {
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  MODEL_PROVIDER_FIREWALL_CONFIGS,
} from "../../contracts/model-providers";
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
} from "../../contracts/client-headers";
import {
  CANONICAL_GUEST_HOME_DIR,
  CANONICAL_WORKING_DIR,
  NETWORK_POLICY_REFRESH_CONNECTOR_SLUGS_MAX,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  RUNNER_POLL_EXCLUDED_RUN_IDS_MAX,
  SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
  SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
  SESSION_HISTORY_GZIP_MIN_BYTES,
} from "../../contracts/runners";

const codexOauthPlaceholders =
  MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"].placeholders!;

const canonicalGuestHomeDirDoc = [
  "Canonical home directory path expected for the sandbox user inside runner guests.",
  "Rust and TypeScript components use this shared contract value when building runner guest paths.",
] as const;

const canonicalWorkingDirDoc = [
  "Canonical working directory path expected inside runner guests.",
  "Rust and TypeScript components use this shared contract value when building runner commands and paths.",
] as const;

const resumeSessionHistoryMaxBytesDoc = [
  "Maximum resume session history blob size accepted by the API, runner, and guest verifier.",
  "Rust and TypeScript components use this shared contract value when validating resume history refs, downloads, and idle-reuse verification.",
] as const;
const networkPolicyRefreshConnectorSlugsMaxDoc = [
  "Maximum connector slugs accepted by the runner network policy refresh endpoint.",
  "Rust runners use this shared contract value to split refresh requests before calling the API.",
] as const;
const runnerPollExcludedRunIdsMaxDoc = [
  "Maximum runner-local claim cooldown exclusions accepted by the poll endpoint.",
  "Rust runners use this shared contract value to bound local cooldown state and poll request size.",
] as const;
const sessionHistoryEncodingGzipDoc = [
  "Wire and blob metadata value for gzip-compressed resume session history.",
  "Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.",
] as const;
const sessionHistoryEncodingIdentityDoc = [
  "Wire and blob metadata value for uncompressed resume session history.",
  "Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.",
] as const;
const sessionHistoryEncodingZstdDoc = [
  "Wire and blob metadata value for zstd-compressed resume session history.",
  "Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.",
] as const;
const sessionHistoryDownloadSourceConfiguredPublicEndpointDoc = [
  "Telemetry value for session history downloads signed with a configured S3 endpoint.",
  "Rust and TypeScript components use this shared contract value when attributing runner download latency.",
] as const;
const sessionHistoryDownloadSourceDefaultR2EndpointDoc = [
  "Telemetry value for session history downloads signed with the default R2 endpoint.",
  "Rust and TypeScript components use this shared contract value when attributing runner download latency.",
] as const;
const sessionHistoryGzipMinBytesDoc = [
  "Minimum raw resume session history size before the guest attempts gzip upload negotiation.",
  "Smaller histories stay identity-encoded to avoid gzip work when it cannot materially reduce transport size.",
] as const;
const clientVersionHeaderDoc = [
  "HTTP header carrying the sending vm0 client component version.",
] as const;
const clientTypeHeaderDoc = [
  "HTTP header carrying the sending vm0 client component type.",
] as const;
const clientSessionIdHeaderDoc = [
  "HTTP header carrying the sending vm0 client session identifier.",
] as const;
const clientRequestIdHeaderDoc = [
  "HTTP header carrying the per-request vm0 client request identifier.",
] as const;

function rustString(value: string): RustConstantValue {
  return { kind: "string", value };
}

function rustU64(value: number): RustConstantValue {
  return { kind: "u64", value };
}

function placeholderRustDoc(name: string): readonly string[] {
  return [
    `Fake marker bytes for the \`${name}\` placeholder.`,
    "This value is not a secret and must not be treated as a usable credential.",
  ];
}

const expectedBindings = [
  {
    rustModulePath: ["client", "headers"],
    rustConstName: "CLIENT_VERSION_HEADER",
    value: rustString(CLIENT_VERSION_HEADER),
    rustDoc: clientVersionHeaderDoc,
  },
  {
    rustModulePath: ["client", "headers"],
    rustConstName: "CLIENT_TYPE_HEADER",
    value: rustString(CLIENT_TYPE_HEADER),
    rustDoc: clientTypeHeaderDoc,
  },
  {
    rustModulePath: ["client", "headers"],
    rustConstName: "CLIENT_SESSION_ID_HEADER",
    value: rustString(CLIENT_SESSION_ID_HEADER),
    rustDoc: clientSessionIdHeaderDoc,
  },
  {
    rustModulePath: ["client", "headers"],
    rustConstName: "CLIENT_REQUEST_ID_HEADER",
    value: rustString(CLIENT_REQUEST_ID_HEADER),
    rustDoc: clientRequestIdHeaderDoc,
  },
  {
    rustModulePath: ["client", "types"],
    rustConstName: "CLIENT_TYPE_APP",
    value: rustString(CLIENT_TYPE_APP),
    rustDoc: ["Client type value for the platform web app."],
  },
  {
    rustModulePath: ["client", "types"],
    rustConstName: "CLIENT_TYPE_CLI",
    value: rustString(CLIENT_TYPE_CLI),
    rustDoc: ["Client type value for the CLI."],
  },
  {
    rustModulePath: ["client", "types"],
    rustConstName: "CLIENT_TYPE_DESKTOP",
    value: rustString(CLIENT_TYPE_DESKTOP),
    rustDoc: ["Client type value for the desktop client."],
  },
  {
    rustModulePath: ["client", "types"],
    rustConstName: "CLIENT_TYPE_GUEST_AGENT",
    value: rustString(CLIENT_TYPE_GUEST_AGENT),
    rustDoc: ["Client type value for the guest agent."],
  },
  {
    rustModulePath: ["client", "types"],
    rustConstName: "CLIENT_TYPE_MITM_ADDON",
    value: rustString(CLIENT_TYPE_MITM_ADDON),
    rustDoc: ["Client type value for the mitmproxy addon."],
  },
  {
    rustModulePath: ["client", "types"],
    rustConstName: "CLIENT_TYPE_RUNNER",
    value: rustString(CLIENT_TYPE_RUNNER),
    rustDoc: ["Client type value for the runner."],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "NETWORK_POLICY_REFRESH_CONNECTOR_SLUGS_MAX",
    value: rustU64(NETWORK_POLICY_REFRESH_CONNECTOR_SLUGS_MAX),
    rustDoc: networkPolicyRefreshConnectorSlugsMaxDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "RESUME_SESSION_HISTORY_MAX_BYTES",
    value: rustU64(RESUME_SESSION_HISTORY_MAX_BYTES),
    rustDoc: resumeSessionHistoryMaxBytesDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "RUNNER_POLL_EXCLUDED_RUN_IDS_MAX",
    value: rustU64(RUNNER_POLL_EXCLUDED_RUN_IDS_MAX),
    rustDoc: runnerPollExcludedRunIdsMaxDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_ENCODING_GZIP",
    value: rustString(SESSION_HISTORY_ENCODING_GZIP),
    rustDoc: sessionHistoryEncodingGzipDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_ENCODING_IDENTITY",
    value: rustString(SESSION_HISTORY_ENCODING_IDENTITY),
    rustDoc: sessionHistoryEncodingIdentityDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_ENCODING_ZSTD",
    value: rustString(SESSION_HISTORY_ENCODING_ZSTD),
    rustDoc: sessionHistoryEncodingZstdDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT",
    value: rustString(
      SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
    ),
    rustDoc: sessionHistoryDownloadSourceConfiguredPublicEndpointDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT",
    value: rustString(SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT),
    rustDoc: sessionHistoryDownloadSourceDefaultR2EndpointDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_GZIP_MIN_BYTES",
    value: rustU64(SESSION_HISTORY_GZIP_MIN_BYTES),
    rustDoc: sessionHistoryGzipMinBytesDoc,
  },
  {
    rustModulePath: ["runners", "paths"],
    rustConstName: "CANONICAL_GUEST_HOME_DIR",
    value: rustString(CANONICAL_GUEST_HOME_DIR),
    rustDoc: canonicalGuestHomeDirDoc,
  },
  {
    rustModulePath: ["runners", "paths"],
    rustConstName: "CANONICAL_WORKING_DIR",
    value: rustString(CANONICAL_WORKING_DIR),
    rustDoc: canonicalWorkingDirDoc,
  },
  {
    rustModulePath: ["codex_oauth_token", "placeholders"],
    rustConstName: "CHATGPT_ACCESS_TOKEN",
    value: rustString(codexOauthPlaceholders.CHATGPT_ACCESS_TOKEN),
    rustDoc: placeholderRustDoc("CHATGPT_ACCESS_TOKEN"),
  },
  {
    rustModulePath: ["codex_oauth_token", "placeholders"],
    rustConstName: "CHATGPT_ACCOUNT_ID",
    value: rustString(codexOauthPlaceholders.CHATGPT_ACCOUNT_ID),
    rustDoc: placeholderRustDoc("CHATGPT_ACCOUNT_ID"),
  },
  {
    rustModulePath: ["codex_oauth_token", "placeholders"],
    rustConstName: "CHATGPT_REFRESH_TOKEN",
    value: rustString(codexOauthPlaceholders.CHATGPT_REFRESH_TOKEN),
    rustDoc: placeholderRustDoc("CHATGPT_REFRESH_TOKEN"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "ANTHROPIC_API_KEY",
    value: rustString(MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_API_KEY),
    rustDoc: placeholderRustDoc("ANTHROPIC_API_KEY"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "ANTHROPIC_AUTH_TOKEN",
    value: rustString(MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_AUTH_TOKEN),
    rustDoc: placeholderRustDoc("ANTHROPIC_AUTH_TOKEN"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CLAUDE_CODE_OAUTH_TOKEN",
    value: rustString(MODEL_PROVIDER_ENV_PLACEHOLDERS.CLAUDE_CODE_OAUTH_TOKEN),
    rustDoc: placeholderRustDoc("CLAUDE_CODE_OAUTH_TOKEN"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "OPENAI_API_KEY",
    value: rustString(MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY),
    rustDoc: placeholderRustDoc("OPENAI_API_KEY"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CHATGPT_ACCESS_TOKEN",
    value: rustString(MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCESS_TOKEN),
    rustDoc: placeholderRustDoc("CHATGPT_ACCESS_TOKEN"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CHATGPT_ACCOUNT_ID",
    value: rustString(MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCOUNT_ID),
    rustDoc: placeholderRustDoc("CHATGPT_ACCOUNT_ID"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CHATGPT_REFRESH_TOKEN",
    value: rustString(MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_REFRESH_TOKEN),
    rustDoc: placeholderRustDoc("CHATGPT_REFRESH_TOKEN"),
  },
] as const;

const exampleModuleDocs = [
  {
    rustModulePath: ["example"],
    rustDoc: ["Example generated constants."],
  },
] satisfies readonly RustConstantModuleDoc[];

function validBinding(
  overrides: Partial<RustConstantBinding> = {},
): RustConstantBinding {
  return {
    rustModulePath: ["example"],
    rustConstName: "EXAMPLE",
    value: rustString("example-value"),
    rustDoc: ["Example generated constant."],
    ...overrides,
  };
}

function summarizeBinding(binding: NormalizedConstantBinding) {
  return {
    rustModulePath: [...binding.rustModulePath],
    rustConstName: binding.rustConstName,
    value: binding.value,
    rustDoc: binding.rustDoc,
  };
}

function compareRustNames(
  left: (typeof expectedBindings)[number],
  right: (typeof expectedBindings)[number],
): number {
  const leftName = [...left.rustModulePath, left.rustConstName].join("::");
  const rightName = [...right.rustModulePath, right.rustConstName].join("::");
  if (leftName < rightName) {
    return -1;
  }
  if (leftName > rightName) {
    return 1;
  }
  return 0;
}

describe("Rust constant bindings", () => {
  it("contains exactly the supported Rust constant set", () => {
    const actualBindings = normalizeConstantBindings(rustConstantBindings).map(
      (binding) => {
        return summarizeBinding(binding);
      },
    );

    expect(actualBindings).toEqual(
      [...expectedBindings].sort(compareRustNames),
    );
  });

  it("renders deterministic Rust constants for the supported registry", () => {
    const firstRender = renderRustConstants(rustConstantBindings);
    const secondRender = renderRustConstants(rustConstantBindings);

    expect(secondRender).toBe(firstRender);
    expect(firstRender).toContain("pub mod codex_oauth_token {");
    expect(firstRender).toContain("pub mod model_provider_env {");
    expect(firstRender).toContain("pub mod client {");
    expect(firstRender).toContain("pub mod runners {");
    expect(firstRender).toContain("pub mod placeholders {");
    expect(firstRender).toContain("pub mod headers {");
    expect(firstRender).toContain(
      "//! Generated Rust constants for `@vm0/api-contracts`.",
    );
    expect(firstRender).toContain(
      "//! Do not edit by hand; regenerate with `cd turbo && pnpm -F @vm0/api-contracts generate:rust`.",
    );
    expect(firstRender).toContain(
      "/// Fake model-provider environment placeholder marker values.",
    );
    expect(firstRender).toContain(
      "/// Fake marker bytes for the `CHATGPT_ACCOUNT_ID` placeholder.",
    );
    expect(firstRender).toContain(
      "/// This value is not a secret and must not be treated as a usable credential.",
    );
    expect(firstRender).toContain(
      "/// Canonical home directory path expected for the sandbox user inside runner guests.",
    );
    expect(firstRender).toContain(
      `pub const CANONICAL_GUEST_HOME_DIR: &str = "${CANONICAL_GUEST_HOME_DIR}";`,
    );
    expect(firstRender).toContain(
      "/// Canonical working directory path expected inside runner guests.",
    );
    expect(firstRender).toContain(
      `pub const CANONICAL_WORKING_DIR: &str = "${CANONICAL_WORKING_DIR}";`,
    );
    expect(firstRender).toContain(
      "/// Maximum resume session history blob size accepted by the API, runner, and guest verifier.",
    );
    expect(firstRender).toContain(
      `pub const RESUME_SESSION_HISTORY_MAX_BYTES: u64 = ${RESUME_SESSION_HISTORY_MAX_BYTES};`,
    );
    expect(firstRender).toContain(
      `pub const RUNNER_POLL_EXCLUDED_RUN_IDS_MAX: u64 = ${RUNNER_POLL_EXCLUDED_RUN_IDS_MAX};`,
    );
    expect(firstRender).toContain(
      `pub const NETWORK_POLICY_REFRESH_CONNECTOR_SLUGS_MAX: u64 = ${NETWORK_POLICY_REFRESH_CONNECTOR_SLUGS_MAX};`,
    );
    expect(firstRender).toContain(
      `pub const SESSION_HISTORY_ENCODING_GZIP: &str = "${SESSION_HISTORY_ENCODING_GZIP}";`,
    );
    expect(firstRender).toContain(
      `pub const SESSION_HISTORY_ENCODING_IDENTITY: &str = "${SESSION_HISTORY_ENCODING_IDENTITY}";`,
    );
    expect(firstRender).toContain(
      `pub const SESSION_HISTORY_ENCODING_ZSTD: &str = "${SESSION_HISTORY_ENCODING_ZSTD}";`,
    );
    expect(firstRender).toContain(
      "pub const SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT: &str =",
    );
    expect(firstRender).toContain(
      `"${SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT}";`,
    );
    expect(firstRender).toContain(
      "pub const SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT: &str =",
    );
    expect(firstRender).toContain(
      `"${SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT}";`,
    );
    expect(firstRender).toContain(
      `pub const SESSION_HISTORY_GZIP_MIN_BYTES: u64 = ${SESSION_HISTORY_GZIP_MIN_BYTES};`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_VERSION_HEADER: &str = "${CLIENT_VERSION_HEADER}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_HEADER: &str = "${CLIENT_TYPE_HEADER}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_SESSION_ID_HEADER: &str = "${CLIENT_SESSION_ID_HEADER}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_REQUEST_ID_HEADER: &str = "${CLIENT_REQUEST_ID_HEADER}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_APP: &str = "${CLIENT_TYPE_APP}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_CLI: &str = "${CLIENT_TYPE_CLI}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_DESKTOP: &str = "${CLIENT_TYPE_DESKTOP}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_GUEST_AGENT: &str = "${CLIENT_TYPE_GUEST_AGENT}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_MITM_ADDON: &str = "${CLIENT_TYPE_MITM_ADDON}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_RUNNER: &str = "${CLIENT_TYPE_RUNNER}";`,
    );
    expect(firstRender).toContain(
      `pub const CHATGPT_ACCOUNT_ID: &str = "${codexOauthPlaceholders.CHATGPT_ACCOUNT_ID}";`,
    );
    expect(firstRender).toContain("pub const OPENAI_API_KEY: &str =");
    expect(firstRender).toContain(
      MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
    );
    expect(firstRender).toContain(
      `pub const CHATGPT_REFRESH_TOKEN: &str = "${codexOauthPlaceholders.CHATGPT_REFRESH_TOKEN}";`,
    );
    expect(firstRender).toContain("shared TypeScript/Rust contract values");
  });

  it("escapes Rust string literals", () => {
    const rendered = renderRustConstants(
      [
        validBinding({
          value: rustString(
            'quote" backslash\\ newline\n carriage\r tab\t control\x01',
          ),
        }),
      ],
      exampleModuleDocs,
      ["Example generated constants root."],
    );

    expect(rendered).toContain(
      'pub const EXAMPLE: &str = "quote\\" backslash\\\\ newline\\n carriage\\r tab\\t control\\u{1}";',
    );
  });

  it("fails clearly when a Rust constant name is invalid", () => {
    expect(() => {
      normalizeConstantBindings([
        validBinding({
          rustConstName: "bad_name",
        }),
      ]);
    }).toThrow("invalid Rust const name");
  });

  it("fails clearly when Rust doc lines are empty", () => {
    expect(() => {
      normalizeConstantBindings([
        validBinding({
          rustDoc: [],
        }),
      ]);
    }).toThrow("missing Rust doc lines");
  });

  it("fails clearly when a u64 constant value is invalid", () => {
    expect(() => {
      normalizeConstantBindings([
        validBinding({
          value: rustU64(-1),
        }),
      ]);
    }).toThrow("invalid u64 constant value");
  });

  it("fails clearly when Rust module docs are missing", () => {
    expect(() => {
      renderRustConstants(
        [validBinding()],
        [],
        ["Example generated constants root."],
      );
    }).toThrow("missing Rust docs for constant module example");
  });

  it("fails clearly when Rust constant names collide", () => {
    expect(() => {
      normalizeConstantBindings([
        validBinding(),
        validBinding({
          value: rustU64(42),
        }),
      ]);
    }).toThrow("duplicate Rust constant binding");
  });
});
