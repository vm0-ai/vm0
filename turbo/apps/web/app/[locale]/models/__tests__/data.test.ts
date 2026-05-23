import { describe, expect, it } from "vitest";
import { VM0_MODEL_TO_PROVIDER } from "@vm0/api-contracts/contracts/model-providers";

import { MODELS, isReasoningModel } from "../data";

describe("models page data", () => {
  it("has unique slugs and modelIds", () => {
    const slugs = MODELS.map((m) => {
      return m.slug;
    });
    const modelIds = MODELS.map((m) => {
      return m.modelId;
    });
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(modelIds).size).toBe(modelIds.length);
  });

  it("documents only VM0-managed reasoning models", () => {
    const reasoningIds = MODELS.filter(isReasoningModel).map((m) => {
      return m.modelId;
    });
    const vm0ModelIds = new Set(Object.keys(VM0_MODEL_TO_PROVIDER));
    expect(
      reasoningIds.every((modelId) => {
        return vm0ModelIds.has(modelId);
      }),
    ).toBe(true);
  });
});
