import { describe, expect, it } from "vitest";
import { VM0_MODEL_TO_PROVIDER } from "@vm0/api-contracts/contracts/model-providers";

import { MODELS } from "../data";

describe("models page data", () => {
  it("only documents VM0 managed models", () => {
    const modelIds = MODELS.map((model) => {
      return model.modelId;
    });
    const vm0ModelIds = new Set(Object.keys(VM0_MODEL_TO_PROVIDER));
    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect(
      modelIds.every((modelId) => {
        return vm0ModelIds.has(modelId);
      }),
    ).toBe(true);
  });
});
