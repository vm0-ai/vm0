import {
  normalizeStringConstantBindings,
  renderRustStringConstants,
  type NormalizedStringConstantBinding,
} from "../generate";
import {
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

const expectedBindings = [
  {
    rustModulePath: ["runners", "paths"],
    rustConstName: "CANONICAL_WORKING_DIR",
    value: CANONICAL_WORKING_DIR,
  },
  {
    rustModulePath: ["codex_oauth_token", "placeholders"],
    rustConstName: "CHATGPT_ACCESS_TOKEN",
    value: codexOauthPlaceholders.CHATGPT_ACCESS_TOKEN,
  },
  {
    rustModulePath: ["codex_oauth_token", "placeholders"],
    rustConstName: "CHATGPT_ACCOUNT_ID",
    value: codexOauthPlaceholders.CHATGPT_ACCOUNT_ID,
  },
  {
    rustModulePath: ["codex_oauth_token", "placeholders"],
    rustConstName: "CHATGPT_REFRESH_TOKEN",
    value: codexOauthPlaceholders.CHATGPT_REFRESH_TOKEN,
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "ANTHROPIC_API_KEY",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_API_KEY,
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "ANTHROPIC_AUTH_TOKEN",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_AUTH_TOKEN,
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CLAUDE_CODE_OAUTH_TOKEN",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.CLAUDE_CODE_OAUTH_TOKEN,
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "OPENAI_API_KEY",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CHATGPT_ACCESS_TOKEN",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCESS_TOKEN,
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CHATGPT_ACCOUNT_ID",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCOUNT_ID,
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CHATGPT_REFRESH_TOKEN",
    value: MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_REFRESH_TOKEN,
  },
] as const;

function validBinding(
  overrides: Partial<RustStringConstantBinding> = {},
): RustStringConstantBinding {
  return {
    rustModulePath: ["example"],
    rustConstName: "EXAMPLE",
    value: "example-value",
    ...overrides,
  };
}

function summarizeBinding(binding: NormalizedStringConstantBinding) {
  return {
    rustModulePath: [...binding.rustModulePath],
    rustConstName: binding.rustConstName,
    value: binding.value,
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
    expect(firstRender).toContain(
      "String constants shared by TypeScript and Rust contracts.",
    );
  });

  it("escapes Rust string literals", () => {
    const rendered = renderRustStringConstants([
      validBinding({
        value: 'quote" backslash\\ newline\n carriage\r tab\t control\x01',
      }),
    ]);

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
