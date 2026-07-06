import { describe, expect, it } from "vitest";

import { getModelDisplayName } from "../model-display-name";

describe("getModelDisplayName", () => {
  it("uses the friendly GPT 5.5 label for the gpt-5.5 model ID", () => {
    expect(getModelDisplayName("gpt-5.5")).toBe("GPT 5.5");
  });

  it("falls back to the raw model ID when no display name is defined", () => {
    expect(getModelDisplayName("custom/model")).toBe("custom/model");
  });
});
