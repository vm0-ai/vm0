import { describe, expect, it } from "vitest";

import { IMAGE_MODEL_IDS } from "../image-models";
import {
  getImageModelPriceTier,
  getVideoModelPriceTier,
} from "../media-model-price-tiers";
import { VIDEO_MODEL_IDS } from "../video-models";

describe("media model price tiers", () => {
  it("ranks image models by what one reference image costs", () => {
    expect(
      Object.fromEntries(
        IMAGE_MODEL_IDS.map((model) => {
          return [model, getImageModelPriceTier(model)];
        }),
      ),
    ).toEqual({
      // 18 credits
      "ideogram/v4": "$",
      // 36 to 57 credits
      "fal-ai/flux-2-pro": "$$",
      "fal-ai/bytedance/seedream/v4/text-to-image": "$$",
      "seedream-5-0-lite-260128": "$$",
      "fal-ai/qwen-image": "$$",
      "alibaba/qwen-image-3/text-to-image": "$$",
      "gpt-image-1": "$$",
      "google/nano-banana-2-lite": "$$",
      "dola-seedream-5-0-pro-260628": "$$",
      // 64 to 96 credits
      "gpt-image-2": "$$$",
      "fal-ai/flux-pro/v1.1-ultra": "$$$",
      "fal-ai/flux-pro/v1.1": "$$$",
      "fal-ai/nano-banana-2": "$$$",
    });
  });

  it("ranks video models by what one reference clip costs", () => {
    expect(
      Object.fromEntries(
        VIDEO_MODEL_IDS.map((model) => {
          return [model, getVideoModelPriceTier(model)];
        }),
      ),
    ).toEqual({
      // 519 and 756 credits
      "seedance-1-5-pro-251215": "$",
      "dreamina-seedance-2-0-mini-260615": "$",
      // 1210 to 1512 credits
      "dreamina-seedance-2-0-fast-260128": "$$",
      "MiniMax-H3": "$$",
      "fal-ai/veo3.1/fast": "$$",
      "dreamina-seedance-2-0-260128": "$$",
      // 2312 credits
      "dreamina-seedance-2-5-260628": "$$$",
      // 4200 credits
      "fal-ai/kling-video/v3/4k/text-to-video": "$$$$",
    });
  });

  it("keeps the cheaper sibling of a family below the model it undercuts", () => {
    expect(getImageModelPriceTier("google/nano-banana-2-lite")).toBe("$$");
    expect(getImageModelPriceTier("fal-ai/nano-banana-2")).toBe("$$$");
    expect(getVideoModelPriceTier("dreamina-seedance-2-0-fast-260128")).toBe(
      "$$",
    );
    expect(getVideoModelPriceTier("dreamina-seedance-2-0-260128")).toBe("$$");
    expect(getVideoModelPriceTier("dreamina-seedance-2-5-260628")).toBe("$$$");
  });
});
