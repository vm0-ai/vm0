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

const EXPECTED_OPEN_DESIGN_WEBSITE_TEMPLATE_IDS = [
  "template:web-prototype-taste-editorial",
  "template:blog-post",
  "template:critique",
  "template:dating-web",
  "template:digital-eguide",
  "template:email-marketing",
  "template:gamified-app",
  "template:kami-landing",
  "template:live-artifact",
  "template:open-design-landing",
  "template:pricing-page",
  "template:saas-landing",
  "template:tweaks",
  "template:waitlist-page",
  "template:web-prototype",
  "template:web-prototype-taste-brutalist",
  "template:web-prototype-taste-soft",
  "template:wireframe-sketch",
] as const;

const EXPECTED_WEBSITE_TEMPLATE_SHA256: Record<string, string> = {
  "black-slabs":
    "38b2f826a86901e113b6e96b52563a839b729fc025fa793b1816d6149221bcf9",
  "blueprint-grid":
    "b5f058f3ec7881e642e31e44e7de1f94465bae783de7fc2d42727bbfd109fad2",
  "coastal-hotel":
    "6bba8c10b85a248a475624767616280fa5d29b757ce230fb4115d746b8b61386",
  "dot-matrix":
    "cfb8f891fa77eca2c3a58f1d95f046f873136f85c9c4a83400cba3a2ccca4ad9",
  "frame-stack":
    "642db1ff8e1c98e4c390245cb0fcda5ce29503721bc2a513c38448b9d4e2d01c",
  "frosted-scatter":
    "548a1faf423baa1c7c11befe41a54ae398cfb5c94df7f957eff108e2afcd613a",
  "gallery-wall":
    "b477b2f05c266eccbd2ab3b822744873dd8a31db03981283688549f2936bd5c6",
  "glass-bloom":
    "8707cce50c5477d43912fd18aa5ab6973aae4fd2287a092967fa25bf4ea38e7c",
  "serif-stack":
    "718d617efd92033a68c476e85bb9231b1e0ff580c08a1f6bedf1b86058e97f13",
  "sticker-pop":
    "8145c78f932ae942108fba00c5de367958f12b4c492d61bc1310892abe51ca66",
  "warm-cards":
    "a795ef022e672d364c7a966eb042d38e460d4dcb996d5eecb0647aac5dd259df",
};

const EXPECTED_WEBSITE_TEMPLATE_V2_SHA256: Record<string, string> = {
  "black-slabs":
    "de6f78c5a524cf3959ca56af7a93ec5bca113555bbd1a5983eebf1bc353971d4",
  "blueprint-grid":
    "dec02c4fe156566272a92b7386cb032cec7e3a1250dd42429ca3e7f42374dc28",
  "coastal-hotel":
    "09d239d7a0e1c27334f2c3c8da9e408174cece6bcc8a34342438598db739aa4e",
  "dot-matrix":
    "0beb9b1bcb12ace6d3541df269a629af8e3b41c8f9d7e3c3fcfe069655cd9074",
  "frame-stack":
    "7c4c13eaa22b4185607c6ac6a726dd931fe896b279b38a6267c0105f81214f8b",
  "frosted-scatter":
    "c67a7baf924ae4b57241e61527dd875d084e38040653a9bbcc659c13d2382cf9",
  "gallery-wall":
    "f6e41fb711b8c9317a425b463a9812e99f2aecb630d1acbfb77ef0965c2ba55f",
  "glass-bloom":
    "713fbac57cf37a0ddd6d7e7d79a0b9f29f8fff7a0aa55bc741bc5dcd0e498d25",
  "serif-stack":
    "6d5d65fb21d6c5ec5627fe32fbfc55e80841a2343f2d91bf3ee3a0f62547766a",
  "sticker-pop":
    "61954f4652e2cc86cd1016a537078ea050fe95735a7477e6bd56c91a0c0aec3b",
  "warm-cards":
    "213197ef200b16738b51b5d6c4a90b6e6c12c86c63207ef6afc31456cdd0d2e1",
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
        "https://static.vm0.io/vm0/artifact-templates/website/website-studio-v2-20260727-ccff774/black-slabs-preview-960x540.webp",
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
        /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/website\/.+-preview-960x540\.webp$/u,
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

  it("exposes restored Open Design templates alongside built-in website templates", () => {
    expect(
      listTemplates("website").map((template) => {
        return template.id;
      }),
    ).toEqual([
      ...EXPECTED_OPEN_DESIGN_WEBSITE_TEMPLATE_IDS,
      ...WEBSITE_TEMPLATE_ITEMS.map((item) => {
        return item.templateId;
      }),
    ]);
  });

  it("restores website targets without dropping mixed-use targets", () => {
    const websiteTemplates = new Map(
      listTemplates("website").map((template) => {
        return [template.id, template] as const;
      }),
    );

    expect(websiteTemplates.get("template:critique")).toMatchObject({
      targets: [
        "website",
        "dashboard-design",
        "report",
        "docs-design",
        "poster",
        "mobile-app-design",
      ],
    });
    expect(websiteTemplates.get("template:digital-eguide")).toMatchObject({
      targets: ["website", "docs-design"],
    });
    expect(websiteTemplates.get("template:gamified-app")).toMatchObject({
      targets: ["website", "mobile-app-design"],
    });
    expect(websiteTemplates.get("template:live-artifact")).toMatchObject({
      targets: ["dashboard-design", "report", "website"],
    });
    expect(websiteTemplates.get("template:tweaks")).toMatchObject({
      targets: [
        "website",
        "dashboard-design",
        "report",
        "docs-design",
        "poster",
        "mobile-app-design",
      ],
    });
    expect(websiteTemplates.get("template:wireframe-sketch")).toMatchObject({
      targets: ["website", "mobile-app-design", "dashboard-design"],
    });
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
