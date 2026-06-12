import { describe, expect, it } from "vitest";
import {
  ILLUSTRATION_ASSET_BASE,
  ILLUSTRATION_STYLES,
  ILLUSTRATION_TEMPLATE_ITEMS,
  illustrationAssetUrl,
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

  it("resolves every logical asset path the app requests", () => {
    // illustrationAssetUrl throws on an unmapped path, and the map is built at
    // module-eval time, so a single missing/typo'd entry would crash a render.
    // Exercise every logical path each call site constructs — not just the ones
    // ILLUSTRATION_TEMPLATE_ITEMS happens to cover. Notably page.tsx always
    // resolves `images/<image>` for its structured data, even for styles that
    // also define a `cover`, so that path must be mapped too.
    for (const style of ILLUSTRATION_STYLES) {
      const paths = [
        `images/${style.image}`,
        ...(style.cover ? [style.cover] : []),
        ...style.refs.map((ref) => {
          return `refs/${style.slug}/${ref}`;
        }),
      ];

      for (const path of paths) {
        const url = illustrationAssetUrl(path);
        expect(url, `${style.slug}: ${path}`).toContain(
          ILLUSTRATION_ASSET_BASE,
        );
      }
    }
  });
});
