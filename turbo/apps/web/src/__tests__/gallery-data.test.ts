import { describe, expect, it } from "vitest";
import {
  GALLERY_CATEGORIES,
  GALLERY_ITEMS,
  buildGalleryPromptHref,
  type GalleryCategory,
} from "../../app/[locale]/gallery/data";

describe("generation gallery data", () => {
  it("uses unique slugs and covers all visible categories", () => {
    const slugs = GALLERY_ITEMS.map((item) => {
      return item.slug;
    });
    expect(new Set(slugs).size).toBe(slugs.length);

    const itemCategories = new Set<GalleryCategory>(
      GALLERY_ITEMS.map((item) => {
        return item.category;
      }),
    );
    const visibleCategories = GALLERY_CATEGORIES.filter((category) => {
      return category !== "all";
    });

    expect([...itemCategories].sort()).toEqual([...visibleCategories].sort());
  });

  it("builds onboarding remix URLs with encoded prompts and resource hints", () => {
    const item = GALLERY_ITEMS[0];
    if (!item) {
      throw new Error("Expected at least one gallery item");
    }

    const href = buildGalleryPromptHref(item, "https://app.vm0.ai");
    const url = new URL(href);

    expect(url.origin).toBe("https://app.vm0.ai");
    expect(url.pathname).toBe("/onboarding");
    expect(url.searchParams.get("prompt")).toContain(item.prompt);
    expect(url.searchParams.get("prompt")).toContain(
      "vm0:image-style:notion-illustration",
    );
  });
});
