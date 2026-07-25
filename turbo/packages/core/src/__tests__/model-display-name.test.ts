import { describe, expect, it } from "vitest";

import { getModelDisplayName } from "../model-display-name";

describe("getModelDisplayName", () => {
  it("uses friendly labels for OpenAI model IDs", () => {
    expect(getModelDisplayName("gpt-5.6-sol")).toBe("GPT 5.6 Sol");
    expect(getModelDisplayName("gpt-5.6-terra")).toBe("GPT 5.6 Terra");
    expect(getModelDisplayName("gpt-5.6-luna")).toBe("GPT 5.6 Luna");
    expect(getModelDisplayName("gpt-5.5")).toBe("GPT 5.5");
  });

  it("uses a friendly label for Kimi K3", () => {
    expect(getModelDisplayName("kimi-k3")).toBe("Kimi K3");
  });

  it("uses friendly labels for Claude Opus 5 model IDs", () => {
    expect(getModelDisplayName("claude-opus-5")).toBe("Claude Opus 5");
    expect(getModelDisplayName("anthropic/claude-opus-5")).toBe(
      "Claude Opus 5",
    );
  });

  it("falls back to the raw model ID when no display name is defined", () => {
    expect(getModelDisplayName("custom/model")).toBe("custom/model");
  });
});
