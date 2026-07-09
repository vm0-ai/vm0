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

const EXPECTED_WEBSITE_TEMPLATE_IDS = [
  "website-template:black-slabs",
  "website-template:blueprint-grid",
  "website-template:coastal-hotel",
  "website-template:frame-stack",
  "website-template:gallery-wall",
  "website-template:glass-bloom",
  "website-template:serif-stack",
  "website-template:sticker-pop",
  "website-template:warm-cards",
] as const;

const EXPECTED_WEBSITE_TEMPLATE_SHA256: Record<string, string> = {
  "black-slabs":
    "7e2dfc9f61dc1b9d187661d36854d27b150c0be92f882d845e5adcfd4054e6ba",
  "blueprint-grid":
    "ff42dcfd99f00eaa5e5d9eec58e417a4337f4f2e715aa5414d7059a419d918ab",
  "coastal-hotel":
    "3818e2e01616e2a3108d63bfda0453c42cc9a41805da7851333ebad28c9bd1df",
  "frame-stack":
    "52934dc77544e0b65e8727a7978c292e69627be1cee6b04b8ab276ee94dc11ac",
  "gallery-wall":
    "d5233f8c2df39753df6a40d6336516efa5db887d8a57978eb86635794040a34b",
  "glass-bloom":
    "60642ffe68a70d953f43b5d27fdff278b10009f4b78497d67d31a09a443e7686",
  "serif-stack":
    "3fcd90b0017801c431f6562c92f8469c065508840cfa85c6fc2efb392ebc0bf6",
  "sticker-pop":
    "1c24754b99a419eeb655cce6ad65819c1ae33b64f990e84591a7652923e4bb70",
  "warm-cards":
    "a11dcf83f4c6c37266905f7333ebc6faca8e82d22499b17cc50905f220b5e3a8",
};

describe("website template items", () => {
  it("exposes the built-in website template catalog in picker order", () => {
    expect(
      WEBSITE_TEMPLATE_ITEMS.map((item) => {
        return item.id;
      }),
    ).toEqual(EXPECTED_WEBSITE_TEMPLATE_IDS);

    const item = WEBSITE_TEMPLATE_ITEMS[0]!;
    expect(item).toMatchObject({
      id: "website-template:black-slabs",
      slug: "black-slabs",
      title: "Black Slabs",
      templateId: "template:black-slabs",
      resourceId: "template:black-slabs",
      previewKind: "iframe",
      sourcePath: "black-slabs",
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

  it("resolves built-in website templates as private R2 pull resources", () => {
    const packages = listWebsiteTemplatePackages();

    expect(packages).toHaveLength(WEBSITE_TEMPLATE_ITEMS.length);
    for (const item of WEBSITE_TEMPLATE_ITEMS) {
      const pkg = findWebsiteTemplatePackage(item.templateId);
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
            sha256: EXPECTED_WEBSITE_TEMPLATE_SHA256[item.slug],
          },
        },
      });
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
    }
  });

  it("keeps built-in R2 website packages out of the unscoped generic template list", () => {
    const unscopedTemplateIds = new Set(
      listTemplates().map((template) => {
        return template.id;
      }),
    );

    expect(
      WEBSITE_TEMPLATE_ITEMS.some((item) => {
        return unscopedTemplateIds.has(item.templateId);
      }),
    ).toBe(false);
  });

  it("exposes built-in R2 website packages to website-targeted generation", () => {
    const websiteTemplates = listTemplates("website");

    for (const item of WEBSITE_TEMPLATE_ITEMS) {
      const template = websiteTemplates.find((entry) => {
        return entry.id === item.templateId;
      });

      expect(template).toEqual(
        expect.objectContaining({
          id: item.templateId,
          kind: "template",
          targets: ["website"],
          source: expect.objectContaining({
            path: item.sourcePath,
            archive: expect.objectContaining({ type: "tar.gz" }),
          }),
        }),
      );
      expect(findWebsiteTemplateResource(item.id)).toEqual(template);
      expect(findWebsiteTemplatePackage(item.id)).toEqual(
        findWebsiteTemplatePackage(item.templateId),
      );
    }
  });
});
