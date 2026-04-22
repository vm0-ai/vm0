import { describe, expect, it } from "vitest";
import { getVm0ModelMultiplier } from "../components/settings/provider-ui-config.ts";

describe("getVm0ModelMultiplier", () => {
  it("returns 0.2 for deepseek-chat", () => {
    expect(getVm0ModelMultiplier("deepseek-chat")).toBe(0.2);
  });

  it("returns undefined for an unknown model", () => {
    expect(getVm0ModelMultiplier("unknown-model")).toBeUndefined();
  });
});
