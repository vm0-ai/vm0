import { describe, expect, it } from "vitest";
import {
  PRESENTATION_GALLERY_ITEMS,
  buildPresentationPromptHref,
} from "../../app/[locale]/presentation-design/data";

describe("presentation design gallery data", () => {
  it("uses unique slugs and covers presentation style/theme combinations", () => {
    const slugs = PRESENTATION_GALLERY_ITEMS.map((item) => {
      return item.slug;
    });
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(PRESENTATION_GALLERY_ITEMS.length).toBe(42);

    const styleThemes = new Set(
      PRESENTATION_GALLERY_ITEMS.map((item) => {
        return `${item.style}:${item.theme}`;
      }),
    );
    expect([...styleThemes].sort()).toEqual([
      "editorial:coral",
      "editorial:forest",
      "editorial:ink",
      "swiss:ikb",
      "swiss:lemon",
      "swiss:lime",
      "swiss:mono",
    ]);
  });

  it("has hosted previews and artifacts for every item", () => {
    expect(
      PRESENTATION_GALLERY_ITEMS.every((item) => {
        return (
          item.previewImage.startsWith("https://cdn.vm0.io/") &&
          item.artifactUrl.startsWith("https://") &&
          item.prompt.includes("zero generate presentation")
        );
      }),
    ).toBe(true);
  });

  it("builds showcase URLs for hosted presentation items", () => {
    const item = PRESENTATION_GALLERY_ITEMS[0];
    if (!item) {
      throw new Error("Expected at least one presentation gallery item");
    }

    const href = buildPresentationPromptHref(item, "en");
    const url = new URL(href, "https://www.vm0.ai");

    expect(href.startsWith("/en/showcase?")).toBe(true);
    expect(url.pathname).toBe("/en/showcase");
    expect(url.searchParams.get("prompt")).toContain(item.prompt);
    expect(url.searchParams.get("website")).toBe(item.artifactUrl);
  });
});
