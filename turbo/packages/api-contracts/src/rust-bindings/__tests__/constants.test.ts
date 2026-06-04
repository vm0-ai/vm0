import {
  normalizeStringConstantBindings,
  renderRustStringConstants,
  type NormalizedStringConstantBinding,
} from "../generate";
import {
  type RustStringConstantModuleDoc,
  type RustStringConstantBinding,
  rustStringConstantBindings,
} from "../constants";
import {
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  MODEL_PROVIDER_FIREWALL_CONFIGS,
} from "../../contracts/model-providers";
import { CANONICAL_WORKING_DIR } from "../../contracts/runners";

const codexOauthPlaceholders =
  MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"].placeholders!;

const canonicalWorkingDirDoc = [
  "Canonical working directory path expected inside runner guests.",
  "Rust and TypeScript components use this shared contract value when building runner commands and paths.",
] as const;

function placeholderRustDoc(name: string): readonly string[] {
  return [
    `Fake marker bytes for the \`${name}\` placeholder.`,
    "This value is not a secret and must not be treated as a usable credential.",
  ];
}

const expectedBindings = [
  {
    rustModulePath: ["runners", "paths"],
    rustConstName: "CANONICAL_WORKING_DIR",
    value: CANONICAL_WORKING_DIR,
    rustDoc: canonicalWorkingDirDoc,
  },
  {
    rustModulePath: ["codex_oauth_token", "placeholders"],
    rustConstName: "CHATGPT_ACCESS_TOKEN",
    value: codexOauthPlaceholders.CHATGPT_ACCESS_TOKEN,
    rustDoc: placeholderRustDoc("CHATGPT_ACCESS_TOKEN"),
  },
  {
    rustModulePath: ["codex_oauth_token", "placeholders"],
    rustConstName: "CHATGPT_ACCOUNT_ID",
    value: codexOauthPlaceholders.CHATGPT_ACCOUNT_ID,
    rustDoc: placeholderRustDoc("CHATGPT_ACCOUNT_ID"),
  },
  {
    rustModulePath: ["codex_oauth_token", "placeholders"],
    rustConstName: "CHATGPT_REFRESH_TOKEN",
    value: codexOauthPlaceholders.CHATGPT_REFRESH_TOKEN,
    rustDoc: placeholderRustDoc("CHATGPT_REFRESH_TOKEN"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "ANTHROPIC_API_KEY",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_API_KEY,
    rustDoc: placeholderRustDoc("ANTHROPIC_API_KEY"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "ANTHROPIC_AUTH_TOKEN",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_AUTH_TOKEN,
    rustDoc: placeholderRustDoc("ANTHROPIC_AUTH_TOKEN"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CLAUDE_CODE_OAUTH_TOKEN",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.CLAUDE_CODE_OAUTH_TOKEN,
    rustDoc: placeholderRustDoc("CLAUDE_CODE_OAUTH_TOKEN"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "OPENAI_API_KEY",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
    rustDoc: placeholderRustDoc("OPENAI_API_KEY"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CHATGPT_ACCESS_TOKEN",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCESS_TOKEN,
    rustDoc: placeholderRustDoc("CHATGPT_ACCESS_TOKEN"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CHATGPT_ACCOUNT_ID",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCOUNT_ID,
    rustDoc: placeholderRustDoc("CHATGPT_ACCOUNT_ID"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CHATGPT_REFRESH_TOKEN",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_REFRESH_TOKEN,
    rustDoc: placeholderRustDoc("CHATGPT_REFRESH_TOKEN"),
  },
] as const;

const exampleModuleDocs = [
  {
    rustModulePath: ["example"],
    rustDoc: ["Example generated constants."],
  },
] satisfies readonly RustStringConstantModuleDoc[];

function validBinding(
  overrides: Partial<RustStringConstantBinding> = {},
): RustStringConstantBinding {
  return {
    rustModulePath: ["example"],
    rustConstName: "EXAMPLE",
    value: "example-value",
    rustDoc: ["Example generated constant."],
    ...overrides,
  };
}

function summarizeBinding(binding: NormalizedStringConstantBinding) {
  return {
    rustModulePath: [...binding.rustModulePath],
    rustConstName: binding.rustConstName,
    value: binding.value,
    rustDoc: binding.rustDoc,
  };
}

describe("Rust string constant bindings", () => {
  it("contains exactly the supported Rust string constant set", () => {
    const actualBindings = normalizeStringConstantBindings(
      rustStringConstantBindings,
    ).map((binding) => {
      return summarizeBinding(binding);
    });

    expect(actualBindings).toEqual(
      [...expectedBindings].sort((left, right) => {
        return [...left.rustModulePath, left.rustConstName]
          .join("::")
          .localeCompare(
            [...right.rustModulePath, right.rustConstName].join("::"),
          );
      }),
    );
  });

  it("renders deterministic Rust constants for the supported registry", () => {
    const firstRender = renderRustStringConstants(rustStringConstantBindings);
    const secondRender = renderRustStringConstants(rustStringConstantBindings);

    expect(secondRender).toBe(firstRender);
    expect(firstRender).toContain("pub mod codex_oauth_token {");
    expect(firstRender).toContain("pub mod model_provider_env {");
    expect(firstRender).toContain("pub mod runners {");
    expect(firstRender).toContain("pub mod placeholders {");
    expect(firstRender).toContain(
      "//! Generated Rust string constants for `@vm0/api-contracts`.",
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
      "/// Canonical working directory path expected inside runner guests.",
    );
    expect(firstRender).toContain(
      `pub const CANONICAL_WORKING_DIR: &str = "${CANONICAL_WORKING_DIR}";`,
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
    const rendered = renderRustStringConstants(
      [
        validBinding({
          value: 'quote" backslash\\ newline\n carriage\r tab\t control\x01',
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
      normalizeStringConstantBindings([
        validBinding({
          rustConstName: "bad_name",
        }),
      ]);
    }).toThrow("invalid Rust const name");
  });

  it("fails clearly when Rust doc lines are empty", () => {
    expect(() => {
      normalizeStringConstantBindings([
        validBinding({
          rustDoc: [],
        }),
      ]);
    }).toThrow("missing Rust doc lines");
  });

  it("fails clearly when Rust module docs are missing", () => {
    expect(() => {
      renderRustStringConstants(
        [validBinding()],
        [],
        ["Example generated constants root."],
      );
    }).toThrow("missing Rust docs for string constant module example");
  });

  it("fails clearly when Rust constant names collide", () => {
    expect(() => {
      normalizeStringConstantBindings([
        validBinding(),
        validBinding({
          value: "different-value",
        }),
      ]);
    }).toThrow("duplicate Rust string constant binding");
  });
});
