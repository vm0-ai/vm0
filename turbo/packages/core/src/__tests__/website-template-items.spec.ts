import { describe, expect, it } from "vitest";
import {
  WEBSITE_TEMPLATE_ITEMS,
  findWebsiteTemplateItem,
} from "../website-template-items";

describe("website template items", () => {
  it("exposes the built-in website template catalog in picker order", () => {
    expect(
      WEBSITE_TEMPLATE_ITEMS.map((item) => {
        return item.id;
      }),
    ).toEqual(["website-template:warm-cards"]);

    const item = WEBSITE_TEMPLATE_ITEMS[0]!;
    expect(item).toMatchObject({
      id: "website-template:warm-cards",
      slug: "warm-cards",
      title: "Warm Cards",
      templateId: "template:warm-cards",
      resourceId: "template:warm-cards",
      previewKind: "iframe",
      sourcePath: "warm-cards",
      target: "website",
    });
  });

  it("uses a static-hosted iframe preview asset", () => {
    for (const item of WEBSITE_TEMPLATE_ITEMS) {
      expect(item.previewKind).toBe("iframe");
      expect(item.previewUrl).toMatch(
        /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/website\/.+\.html$/u,
      );
      expect(item.previewUrl).not.toContain("drive.google.com");
      expect(item.previewUrl).not.toContain("docs.google.com");
      expect(item.previewUrl).not.toContain("raw.githubusercontent.com");
    }
  });

  it("resolves picker, slug, template, and resource identifiers", () => {
    const item = WEBSITE_TEMPLATE_ITEMS[0]!;

    expect(findWebsiteTemplateItem(item.id)).toBe(item);
    expect(findWebsiteTemplateItem(item.slug)).toBe(item);
    expect(findWebsiteTemplateItem(item.templateId)).toBe(item);
    expect(findWebsiteTemplateItem(item.resourceId)).toBe(item);
    expect(findWebsiteTemplateItem("template:web-prototype")).toBeUndefined();
  });

  it("does not expose existing Open Design website templates through the picker catalog", () => {
    const websiteTemplateIds = WEBSITE_TEMPLATE_ITEMS.flatMap((item) => {
      return [item.id, item.templateId, item.resourceId];
    });

    expect(websiteTemplateIds).not.toContain("template:web-prototype");
    expect(websiteTemplateIds).not.toContain(
      "template:web-prototype-taste-editorial",
    );
    expect(websiteTemplateIds).not.toContain(
      "template:web-prototype-taste-brutalist",
    );
    expect(websiteTemplateIds).not.toContain(
      "template:web-prototype-taste-soft",
    );
  });
});
