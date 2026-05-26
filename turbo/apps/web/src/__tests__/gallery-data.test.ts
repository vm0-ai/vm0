import { describe, expect, it } from "vitest";
import {
  GALLERY_CATEGORIES,
  GALLERY_CATEGORY_LABELS,
  GALLERY_ITEMS,
  buildGalleryPromptHref,
  type GalleryCategory,
} from "../../app/[locale]/web-design/data";

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

  it("only shows the hosted website design gallery for now", () => {
    expect(GALLERY_CATEGORIES).toEqual(["all", "website"]);
    expect(GALLERY_CATEGORY_LABELS.website).toBe("Website Design");
    expect(GALLERY_ITEMS.length).toBe(10);
    expect(
      GALLERY_ITEMS.every((item) => {
        return item.category === "website" && item.artifactUrl;
      }),
    ).toBe(true);
  });

  it("builds web showcase URLs for hosted website items", () => {
    const item = GALLERY_ITEMS.find((candidate) => {
      return candidate.artifactUrl;
    });
    if (!item?.artifactUrl) {
      throw new Error("Expected at least one hosted gallery website");
    }

    const href = buildGalleryPromptHref(item, "en");
    const url = new URL(href, "https://www.vm0.ai");

    expect(href.startsWith("/en/showcase?")).toBe(true);
    expect(url.pathname).toBe("/en/showcase");
    expect(url.searchParams.get("prompt")).toContain(item.prompt);
    expect(url.searchParams.get("website")).toBe(item.artifactUrl);
  });
});
