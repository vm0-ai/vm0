import { describe, expect, it } from "vitest";
import { VM0_MODEL_TO_PROVIDER } from "@vm0/api-contracts/contracts/model-providers";

import { MODELS } from "../data";

describe("models page data", () => {
  it("covers every VM0 managed model", () => {
    const modelIds = MODELS.map((model) => {
      return model.modelId;
    });
    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect([...modelIds].sort()).toStrictEqual(
      Object.keys(VM0_MODEL_TO_PROVIDER).sort(),
    );
  });
});
