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
  "website-template:dot-matrix",
  "website-template:frame-stack",
  "website-template:frosted-scatter",
  "website-template:gallery-wall",
  "website-template:glass-bloom",
  "website-template:serif-stack",
  "website-template:sticker-pop",
  "website-template:warm-cards",
] as const;

const EXPECTED_WEBSITE_TEMPLATE_SHA256: Record<string, string> = {
  "black-slabs":
    "8f30984e444283bf0322106a1099623346e153bc11d26e3044fbf61ef43514c3",
  "blueprint-grid":
    "97c2edd94467bc414f0d9fc27cafa048cb2a7aaba3df5159df519a2bb2b97a4e",
  "coastal-hotel":
    "9633475124da5728cbf99a7333b494f74842232faaf675bc7878a3ebcdf59bcb",
  "dot-matrix":
    "f489a51fb99d8fadff8712d0406df06ac1a530116ebe612ab3f8605daa2bcce2",
  "frame-stack":
    "4587e93da51652c0c16c2d0706e8437001305214e4e6b8b1c18a6538b3daa127",
  "frosted-scatter":
    "00e343ace0673ece5903a2b6abbad6bb960c17796e0cfa5cce0bcab7e6bcdd7b",
  "gallery-wall":
    "c90332053b24572feadecb3994925ed317957e1cb17b0080cfebc6f4d9e93bd1",
  "glass-bloom":
    "0c61488baa294fb13c58aa129e3ae99f0cd4ff9125459761a1b2c1390b860f93",
  "serif-stack":
    "cf5137a7b6788f4d7cb24bda358a8e1971c0e7ed026d50e6cf292f6bf0cd0c14",
  "sticker-pop":
    "2086113018279f28e23489cf7a0f3663c37a23210fb106c4ed48d8c19923f78f",
  "warm-cards":
    "2721c013f76e1b2eea09282269b33d7f143b7e83ee3e701e83a0fcf7773852dd",
};

const EXPECTED_WEBSITE_TEMPLATE_V2_SHA256: Record<string, string> = {
  "black-slabs":
    "840a02ad6e9caac5abfa6abea991f7a0c71fdee16700011d64ad3af7013164cc",
  "blueprint-grid":
    "8d02b52dfe72d8d0e59ba69e6ee9ffe3ae527c68e6cc89afe04264801c5c8d53",
  "coastal-hotel":
    "b9e2ac6e12ee525ce8896b704071eebf439590700d95060c6db76c90d167a08e",
  "dot-matrix":
    "823b02b5ac17d4899de867b99a9332912f6ace671cce8a72a91cff9426a661b3",
  "frame-stack":
    "c2a9d32dadbc0e00c3e29fe78eebe6525757b81e21d39eb25cbf34adb98e2322",
  "frosted-scatter":
    "a2a191134d56a33b90bfc0540c97a022f8f4b028d942ddcd482380ad5e9589ca",
  "gallery-wall":
    "0295121b12c8ded9a93efd3781e308020ffcb5b71b1f9fc682cac96cf4d5c14a",
  "glass-bloom":
    "48374e9ded67087f481b82d260a70438aa2fd9abc33367e4190fa5fb606214e4",
  "serif-stack":
    "9cb399465cb5c66ae7fb857986450ef154e7dc7c6e7c59a89281011933c55ab3",
  "sticker-pop":
    "5802135c5f922d6ae3748d13468e6bc24549f70c946fdf109b34ff02de471b09",
  "warm-cards":
    "0973164b9b4e3811ab565430043f74a6fa0546ca6f215db64a1eb79bd14542e6",
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
      previewImageUrl:
        "https://static.vm0.io/vm0/artifact-templates/website/website-studio-v2-20260708-5f944f83/black-slabs-preview-480x270.webp",
      sourcePath: "black-slabs",
      target: "website",
    });
  });

  it("uses static-hosted preview assets", () => {
    for (const item of WEBSITE_TEMPLATE_ITEMS) {
      expect(item.previewKind).toBe("iframe");
      expect(item.previewUrl).toMatch(
        /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/website\/.+\.html$/u,
      );
      expect(item.previewImageUrl).toMatch(
        /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/website\/.+-preview-(?:480x270|960x540)\.webp$/u,
      );
      expect(item.previewUrl).not.toContain("drive.google.com");
      expect(item.previewUrl).not.toContain("docs.google.com");
      expect(item.previewUrl).not.toContain("raw.githubusercontent.com");
      expect(item.previewImageUrl).not.toContain("drive.google.com");
      expect(item.previewImageUrl).not.toContain("docs.google.com");
      expect(item.previewImageUrl).not.toContain("raw.githubusercontent.com");
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

  it("does not expose Open Design website registry entries", () => {
    expect(
      listTemplates("website").map((template) => {
        return template.id;
      }),
    ).toEqual(
      WEBSITE_TEMPLATE_ITEMS.map((item) => {
        return item.templateId;
      }),
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

  it("keeps all v2 packages additive to the picker catalog", () => {
    for (const item of WEBSITE_TEMPLATE_ITEMS) {
      const resourceId = `${item.resourceId}-v2`;
      const pkg = findWebsiteTemplatePackage(resourceId);

      expect(pkg).toMatchObject({
        templateId: `${item.templateId}-v2`,
        resourceId,
        slug: item.sourcePath,
        source: {
          path: item.sourcePath,
          archive: {
            type: "tar.gz",
            sha256: EXPECTED_WEBSITE_TEMPLATE_V2_SHA256[item.slug],
          },
        },
      });
      expect(findWebsiteTemplateResource(resourceId)).toEqual(
        expect.objectContaining({
          id: resourceId,
          targets: ["website"],
        }),
      );
    }
    expect(listWebsiteTemplatePackages()).toHaveLength(
      WEBSITE_TEMPLATE_ITEMS.length,
    );
    expect(
      listTemplates("website").some((template) => {
        return template.id.endsWith("-v2");
      }),
    ).toBe(false);
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
