import { describe, expect, it } from "vitest";
import { getVm0VisibleModels } from "@vm0/api-contracts/contracts/model-providers";

import { MODELS } from "../data";

describe("models page data", () => {
  it("covers every default-visible VM0 managed model", () => {
    const modelIds = MODELS.map((model) => {
      return model.modelId;
    });
    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect([...modelIds].sort()).toStrictEqual(getVm0VisibleModels().sort());
  });
});
