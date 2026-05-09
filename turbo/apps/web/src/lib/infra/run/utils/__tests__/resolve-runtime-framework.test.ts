import { describe, expect, it } from "vitest";
import { resolveRuntimeFramework } from "../resolve-runtime-framework";

describe("resolveRuntimeFramework", () => {
  it("defaults to claude-code when no framework source is available", () => {
    expect(resolveRuntimeFramework({})).toBe("claude-code");
  });

  it("uses compose framework as the fallback source", () => {
    expect(
      resolveRuntimeFramework({
        agentCompose: { agents: { main: { framework: "codex" } } },
      }),
    ).toBe("codex");
  });

  it("lets provider type override compose framework", () => {
    expect(
      resolveRuntimeFramework({
        providerType: "openai-api-key",
        agentCompose: { agents: { main: { framework: "claude-code" } } },
      }),
    ).toBe("codex");
  });

  it("lets provider framework preserve meta-provider concrete routing", () => {
    expect(
      resolveRuntimeFramework({
        providerFramework: "codex",
        providerType: "vm0",
        agentCompose: { agents: { main: { framework: "claude-code" } } },
      }),
    ).toBe("codex");
  });

  it("lets final resolved framework win over all fallback sources", () => {
    expect(
      resolveRuntimeFramework({
        resolvedFramework: "codex",
        providerFramework: "claude-code",
        providerType: "anthropic-api-key",
        agentCompose: { agents: { main: { framework: "claude-code" } } },
      }),
    ).toBe("codex");
  });
});
