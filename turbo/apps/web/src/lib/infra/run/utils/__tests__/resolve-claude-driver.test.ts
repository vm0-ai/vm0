import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import { resolveClaudeDriver } from "../resolve-claude-driver";

describe("resolveClaudeDriver", () => {
  it("uses interactive only for claude-code-oauth-token when the switch is enabled", () => {
    expect(
      resolveClaudeDriver({
        resolvedModelProvider: "claude-code-oauth-token",
        featureFlags: {
          [FeatureSwitchKey.ClaudeInteractiveDriver]: true,
        },
      }),
    ).toBe("interactive");
  });

  it("keeps print mode when the switch is disabled", () => {
    expect(
      resolveClaudeDriver({
        resolvedModelProvider: "claude-code-oauth-token",
        featureFlags: {
          [FeatureSwitchKey.ClaudeInteractiveDriver]: false,
        },
      }),
    ).toBe("print");
  });

  it("keeps print mode for other Claude providers", () => {
    expect(
      resolveClaudeDriver({
        resolvedModelProvider: "anthropic-api-key",
        featureFlags: {
          [FeatureSwitchKey.ClaudeInteractiveDriver]: true,
        },
      }),
    ).toBe("print");
  });

  it("keeps print mode without a resolved provider", () => {
    expect(
      resolveClaudeDriver({
        featureFlags: {
          [FeatureSwitchKey.ClaudeInteractiveDriver]: true,
        },
      }),
    ).toBe("print");
  });
});
