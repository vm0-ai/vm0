import { describe, it, expect } from "vitest";
import { validateFrameworkApiKey } from "../validate-framework-api-key";
import type { ModelProviderType } from "@vm0/api-contracts/contracts/model-providers";
import type { AgentComposeYaml } from "../../../agent-compose/types";

function makeCompose(
  framework: "claude-code" | "codex",
  environment?: Record<string, string>,
): AgentComposeYaml {
  return {
    version: "1",
    agents: {
      "test-agent": {
        framework,
        environment,
      },
    },
  };
}

describe("validateFrameworkApiKey", () => {
  describe("claude-code (exempt — gated by checkModelProviderConfigured)", () => {
    it("returns silently with literal ANTHROPIC_API_KEY", () => {
      expect(() => {
        validateFrameworkApiKey(
          makeCompose("claude-code", { ANTHROPIC_API_KEY: "sk-ant-..." }),
        );
      }).not.toThrow();
    });
    it("returns silently with no environment block at all", () => {
      expect(() => {
        validateFrameworkApiKey(makeCompose("claude-code"));
      }).not.toThrow();
    });
    it("returns silently when environment is empty (org-provider injection path)", () => {
      expect(() => {
        validateFrameworkApiKey(makeCompose("claude-code", {}));
      }).not.toThrow();
    });
  });

  describe("codex", () => {
    it("accepts compose with literal OPENAI_API_KEY", () => {
      expect(() => {
        validateFrameworkApiKey(
          makeCompose("codex", { OPENAI_API_KEY: "sk-..." }),
        );
      }).not.toThrow();
    });
    it("accepts compose with secret-reference OPENAI_API_KEY", () => {
      expect(() => {
        validateFrameworkApiKey(
          makeCompose("codex", {
            OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
          }),
        );
      }).not.toThrow();
    });
    it("rejects compose without OPENAI_API_KEY", () => {
      expect(() => {
        validateFrameworkApiKey(makeCompose("codex", {}));
      }).toThrow(/OPENAI_API_KEY/);
    });
    it("rejects compose with no environment block", () => {
      expect(() => {
        validateFrameworkApiKey(makeCompose("codex"));
      }).toThrow(/OPENAI_API_KEY/);
    });
    it("rejects compose with claude-only key", () => {
      expect(() => {
        validateFrameworkApiKey(
          makeCompose("codex", { ANTHROPIC_API_KEY: "sk-ant-..." }),
        );
      }).toThrow(/OPENAI_API_KEY/);
    });
    it("error message names the framework", () => {
      expect(() => {
        validateFrameworkApiKey(makeCompose("codex", {}));
      }).toThrow(/codex/);
    });

    it("rejects codex compose when providerType is null", () => {
      expect(() => {
        validateFrameworkApiKey(makeCompose("codex", {}), null);
      }).toThrow(/OPENAI_API_KEY/);
    });

    it("accepts codex compose when openai-api-key provider satisfies OPENAI_API_KEY", () => {
      expect(() => {
        validateFrameworkApiKey(
          makeCompose("codex", {}),
          "openai-api-key" as ModelProviderType,
        );
      }).not.toThrow();
    });
  });

  describe("provider framework wins over compose framework (Epic #11520)", () => {
    // Production-shaped path from #11645: thread eager-pinned to an
    // openai-api-key provider on a compose that still says claude-code.
    // The validator must treat the run as codex (provider's framework
    // wins) and verify the codex env var, not the claude-code path.

    it("accepts compose=claude-code + provider=openai-api-key (provider satisfies OPENAI_API_KEY)", () => {
      expect(() => {
        validateFrameworkApiKey(
          makeCompose("claude-code", {}),
          "openai-api-key" as ModelProviderType,
        );
      }).not.toThrow();
    });

    it("ignores providerType when its framework is claude-code (matches compose)", () => {
      // anthropic-api-key resolves to claude-code → exempt path, no env
      // check required regardless of compose declaration.
      expect(() => {
        validateFrameworkApiKey(
          makeCompose("claude-code", {}),
          "anthropic-api-key" as ModelProviderType,
        );
      }).not.toThrow();
    });
  });

  it("returns silently when compose has no agents", () => {
    const empty: AgentComposeYaml = { version: "1", agents: {} };
    expect(() => {
      validateFrameworkApiKey(empty);
    }).not.toThrow();
  });
});
