import { describe, expect, it } from "vitest";
import {
  ILLUSTRATION_ASSET_BASE,
  ILLUSTRATION_TEMPLATE_ITEMS,
} from "../illustration-template-items";
import { findImageStyle } from "../resource-registry";

describe("illustration template items", () => {
  it("resolve every image style against the resource registry", () => {
    for (const item of ILLUSTRATION_TEMPLATE_ITEMS) {
      const style = findImageStyle(item.illustrationStyleId);

      expect(style, item.illustrationStyleId).toBeDefined();
      expect(item.tag).toBe("illustration");
    }
  });

  it("defines preview image arrays", () => {
    for (const item of ILLUSTRATION_TEMPLATE_ITEMS) {
      expect(item.previewImage).toContain(ILLUSTRATION_ASSET_BASE);
      expect(item.previewImages.length).toBe(item.variationCount);
    }
  });
});
