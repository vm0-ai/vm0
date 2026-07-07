import { describe, expect, it } from "vitest";
import {
  WEBSITE_TEMPLATE_ITEMS,
  findWebsiteTemplateItem,
} from "../website-template-items";
import {
  findWebsiteTemplatePackage,
  findWebsiteTemplateResource,
  listTemplates,
  listWebsiteTemplatePackages,
} from "../resource-registry";

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

  it("resolves the built-in website template as a private R2 pull resource", () => {
    const item = WEBSITE_TEMPLATE_ITEMS[0]!;
    const [pkg] = listWebsiteTemplatePackages();

    expect(pkg).toMatchObject({
      templateId: item.templateId,
      resourceId: item.resourceId,
      slug: item.sourcePath,
      name: item.title,
      description: item.description,
      source: {
        path: item.sourcePath,
        archive: {
          type: "tar.gz",
          sha256:
            "1fafd9e5541dfe53ffdfafcbb6e45d525328c9a0cc5bb4afb2a06b4685e153d2",
        },
      },
    });
    expect(findWebsiteTemplatePackage(item.templateId)).toBe(pkg);
    expect(findWebsiteTemplateResource(item.resourceId)).toEqual(
      expect.objectContaining({
        id: item.resourceId,
        kind: "template",
        targets: ["website"],
        source: expect.objectContaining({
          path: item.sourcePath,
          archive: expect.objectContaining({ type: "tar.gz" }),
        }),
      }),
    );
  });

  it("keeps built-in R2 website packages out of the unscoped generic template list", () => {
    expect(
      listTemplates().some((template) => {
        return template.id === "template:warm-cards";
      }),
    ).toBe(false);
  });

  it("exposes built-in R2 website packages to website-targeted generation", () => {
    const template = listTemplates("website").find((entry) => {
      return entry.id === "template:warm-cards";
    });

    expect(template).toEqual(
      expect.objectContaining({
        id: "template:warm-cards",
        kind: "template",
        targets: ["website"],
        source: expect.objectContaining({
          path: "warm-cards",
          archive: expect.objectContaining({ type: "tar.gz" }),
        }),
      }),
    );
    expect(findWebsiteTemplateResource("website-template:warm-cards")).toEqual(
      template,
    );
    expect(findWebsiteTemplatePackage("website-template:warm-cards")).toEqual(
      findWebsiteTemplatePackage("template:warm-cards"),
    );
  });
});
