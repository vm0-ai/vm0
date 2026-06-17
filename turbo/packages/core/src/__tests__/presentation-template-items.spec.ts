import { describe, expect, it } from "vitest";
import {
  PRESENTATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
} from "../presentation-template-items";
import { findDesignSystem, findTemplate } from "../resource-registry";

const FORBIDDEN_ASSET_URL_PARTS = [
  "drive.google.com",
  "googleusercontent.com",
  "raw.githubusercontent.com",
  "file://",
] as const;

function stripRegistryPrefix(id: string, prefix: string): string {
  expect(id.startsWith(prefix)).toBe(true);
  return id.slice(prefix.length);
}

function expectCdnPreviewImages(
  item: (typeof PRESENTATION_TEMPLATE_PICKER_ITEMS)[number],
): void {
  expect(item.previewImages.length).toBeGreaterThan(0);
  expect(item.previewImage).toBe(item.previewImages[0]);

  for (const url of item.previewImages) {
    expect(url).toMatch(/^https:\/\/cdn\.vm0\.io\/artifacts\/.+\.png$/);
  }

  const assetUrls = [
    item.previewImage,
    item.embedUrl,
    ...item.previewImages,
    ...(item.previewHtmls ?? []),
  ];

  for (const url of assetUrls) {
    for (const forbidden of FORBIDDEN_ASSET_URL_PARTS) {
      expect(url).not.toContain(forbidden);
    }
  }
}

function expectCdnPreviewHtmls(
  item: (typeof PRESENTATION_TEMPLATE_PICKER_ITEMS)[number],
): void {
  expect(item.previewHtmls?.length).toBe(15);

  for (const url of item.previewHtmls ?? []) {
    expect(url).toMatch(/^https:\/\/cdn\.vm0\.io\/artifacts\/.+\.html$/);
  }
}

function expectR2ArchiveSource(id: string, sourcePath: string): void {
  const entry = id.startsWith("template:")
    ? findTemplate(id)
    : findDesignSystem(id);

  expect(entry, id).toBeDefined();
  if (!entry) {
    throw new Error(`missing registry entry ${id}`);
  }

  expect(entry.source.path).toBe(sourcePath);
  expect(entry.source.repo).toBeUndefined();
  expect(entry.source.ref).toBeUndefined();
  expect(entry.source.archive?.type).toBe("tar.gz");
  expect(entry.source.archive?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(entry.source.archive).not.toHaveProperty("url");
}

const BATCH_PRESENTATION_PICKER_ITEMS = [
  {
    slug: "crayon-learning-deck",
    designSystemId: "design-system:crayon",
    templateId: "template:html-ppt-crayon",
    designSourcePath: "presentation-design-system/crayon",
    templateSourcePath: "presentation-template/crayon",
  },
  {
    slug: "creative-agency-presentation",
    designSystemId: "design-system:creative-agency",
    templateId: "template:html-ppt-creative-agency",
    designSourcePath: "presentation-design-system/creative-agency",
    templateSourcePath: "presentation-template/creative-agency",
  },
  {
    slug: "data-report-presentation",
    designSystemId: "design-system:data-report",
    templateId: "template:html-ppt-data-report",
    designSourcePath: "presentation-design-system/data-report",
    templateSourcePath: "presentation-template/data-report",
  },
  {
    slug: "editorial-magazine-deck",
    designSystemId: "design-system:editorial-magazine",
    templateId: "template:html-ppt-editorial-magazine",
    designSourcePath: "presentation-design-system/editorial-magazine",
    templateSourcePath: "presentation-template/editorial-magazine",
  },
  {
    slug: "landing-consulting-deck",
    designSystemId: "design-system:landing-consulting",
    templateId: "template:html-ppt-landing-consulting",
    designSourcePath: "presentation-design-system/landing-consulting",
    templateSourcePath: "presentation-template/landing-consulting",
  },
  {
    slug: "lumina-creative-studio",
    designSystemId: "design-system:lumina",
    templateId: "template:html-ppt-lumina",
    designSourcePath: "presentation-design-system/lumina",
    templateSourcePath: "presentation-template/lumina",
  },
  {
    slug: "mosaic-geometric-pitch",
    designSystemId: "design-system:mosaic-geometric",
    templateId: "template:html-ppt-mosaic-geometric",
    designSourcePath: "presentation-design-system/mosaic-geometric",
    templateSourcePath: "presentation-template/mosaic-geometric",
  },
  {
    slug: "playful-pop-deck",
    designSystemId: "design-system:playful-pop",
    templateId: "template:html-ppt-playful-pop",
    designSourcePath: "presentation-design-system/playful-pop",
    templateSourcePath: "presentation-template/playful-pop",
  },
] as const;

function expectOpenDesignSource(
  id: string,
  sourcePathPrefix: "design-systems/" | "design-templates/",
): void {
  const entry = id.startsWith("template:")
    ? findTemplate(id)
    : findDesignSystem(id);

  expect(entry, id).toBeDefined();
  if (!entry) {
    throw new Error(`missing registry entry ${id}`);
  }

  expect(entry.source.path).toMatch(new RegExp(`^${sourcePathPrefix}`));
  expect(entry.source.repo).toBeUndefined();
  expect(entry.source.ref).toBeUndefined();
  expect(entry.source.archive).toBeUndefined();
}

describe("presentation template items", () => {
  const allPresentationItems = [
    ...PRESENTATION_TEMPLATE_ITEMS,
    ...PRESENTATION_TEMPLATE_PICKER_ITEMS,
  ];

  it("resolve every design system and template against the resource registry", () => {
    for (const item of allPresentationItems) {
      const designSystem = findDesignSystem(item.designSystemId);
      const template = findTemplate(item.templateId);

      expect(designSystem, item.designSystemId).toBeDefined();
      expect(template, item.templateId).toBeDefined();
      expect(template?.targets).toContain("presentation");
    }
  });

  it("keeps prompt references aligned with structured ids", () => {
    for (const item of allPresentationItems) {
      const promptDesignSystem = stripRegistryPrefix(
        item.designSystemId,
        "design-system:",
      );
      const promptTemplate = stripRegistryPrefix(item.templateId, "template:");

      expect(item.prompt).toContain(`design system \`${promptDesignSystem}\``);
      expect(item.prompt).toContain(`template \`${promptTemplate}\``);
    }
  });

  it("defines explicit preview image arrays", () => {
    for (const item of allPresentationItems) {
      expect(Array.isArray(item.previewImages)).toBe(true);
    }
  });

  it("keeps the legacy catalog available and resolvable", () => {
    const legacyItem = PRESENTATION_TEMPLATE_ITEMS.find((candidate) => {
      return candidate.slug === "starship-v3-investor-update";
    });

    expect(legacyItem).toBeDefined();
    expect(
      PRESENTATION_TEMPLATE_PICKER_ITEMS.some((candidate) => {
        return candidate.slug === legacyItem?.slug;
      }),
    ).toBe(false);
    expect(legacyItem?.designSystemId).toBe("design-system:spacex");
    expect(legacyItem?.templateId).toBe("template:html-ppt-pitch-deck");
    expect(findDesignSystem(legacyItem?.designSystemId ?? "")).toBeDefined();
    expect(findTemplate(legacyItem?.templateId ?? "")?.targets).toContain(
      "presentation",
    );
  });

  it("keeps legacy presentation templates on the Open Design source path", () => {
    for (const item of PRESENTATION_TEMPLATE_ITEMS) {
      expectOpenDesignSource(item.designSystemId, "design-systems/");
      expectOpenDesignSource(item.templateId, "design-templates/");
    }
  });

  it("keeps the picker catalog separate from the legacy catalog", () => {
    expect(
      PRESENTATION_TEMPLATE_ITEMS.some((candidate) => {
        return candidate.slug === "playful-launch-presentation";
      }),
    ).toBe(false);

    const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
      return candidate.slug === "playful-launch-presentation";
    });

    expect(item).toBeDefined();
    if (!item) {
      throw new Error("missing playful-launch-presentation picker item");
    }

    expect(item.designSystemId).toBe("design-system:playful-editorial");
    expect(item.templateId).toBe("template:html-ppt-playful-launch");
    expect(item.previewImages.length).toBe(15);
    expect(item.previewImage).toBe(item.previewImages[0]);
    expect(item.embedUrl).toMatch(
      /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/aplocoto\.html$/,
    );
    expectCdnPreviewImages(item);
    expect(findDesignSystem(item.designSystemId)).toBeDefined();
    expect(findTemplate(item.templateId)?.targets).toContain("presentation");
    expectR2ArchiveSource(
      item.designSystemId,
      "presentation-design-system/playful-editorial",
    );
    expectR2ArchiveSource(item.templateId, "presentation-template/aplocoto");
  });

  it("keeps the business data picker item aligned with CDN assets", () => {
    expect(
      PRESENTATION_TEMPLATE_ITEMS.some((candidate) => {
        return candidate.slug === "business-data-presentation";
      }),
    ).toBe(false);

    const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
      return candidate.slug === "business-data-presentation";
    });

    expect(item).toBeDefined();
    if (!item) {
      throw new Error("missing business-data-presentation picker item");
    }

    expect(item.designSystemId).toBe("design-system:business-data");
    expect(item.templateId).toBe("template:html-ppt-business-data");
    expect(item.previewImages.length).toBe(15);
    expect(item.embedUrl).toMatch(
      /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/business-data\.html$/,
    );
    expectCdnPreviewImages(item);
    expect(findDesignSystem(item.designSystemId)).toBeDefined();
    expect(findTemplate(item.templateId)?.targets).toContain("presentation");
    expectR2ArchiveSource(
      item.designSystemId,
      "presentation-design-system/business-data",
    );
    expectR2ArchiveSource(
      item.templateId,
      "presentation-template/business-data",
    );
  });

  it("keeps the batch picker items aligned with CDN assets and private R2 sources", () => {
    for (const expected of BATCH_PRESENTATION_PICKER_ITEMS) {
      const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
        return candidate.slug === expected.slug;
      });

      expect(item, expected.slug).toBeDefined();
      if (!item) {
        throw new Error(`missing ${expected.slug} picker item`);
      }

      expect(item.designSystemId).toBe(expected.designSystemId);
      expect(item.templateId).toBe(expected.templateId);
      expect(item.previewImages.length).toBe(15);
      expect(item.previewImage).toBe(item.previewImages[0]);
      expect(item.embedUrl).toMatch(
        /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/example\.html$/,
      );
      expectCdnPreviewImages(item);
      expectCdnPreviewHtmls(item);
      expect(findDesignSystem(item.designSystemId)).toBeDefined();
      expect(findTemplate(item.templateId)?.targets).toContain("presentation");
      expectR2ArchiveSource(item.designSystemId, expected.designSourcePath);
      expectR2ArchiveSource(item.templateId, expected.templateSourcePath);
    }
  });

  it("keeps the botane picker item aligned with CDN assets", () => {
    const botaneItem = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
      return candidate.slug === "botane-organic-deck";
    });

    expect(botaneItem).toBeDefined();
    if (!botaneItem) {
      throw new Error("Botane picker item is missing");
    }
    expect(botaneItem.designSystemId).toBe("design-system:botane-organic");
    expect(botaneItem.templateId).toBe("template:html-ppt-botane-organic");
    expect(botaneItem.previewImages.length).toBe(15);
    expect(botaneItem.previewImage).toBe(botaneItem.previewImages[0]);
    expect(botaneItem.embedUrl).toMatch(
      /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/botane-organic\.html$/,
    );
    expectCdnPreviewImages(botaneItem);
    expect(findDesignSystem(botaneItem.designSystemId)).toBeDefined();
    expect(findTemplate(botaneItem.templateId)?.targets).toContain(
      "presentation",
    );
    expectR2ArchiveSource(
      botaneItem.designSystemId,
      "presentation-design-system/botane-organic",
    );
    expectR2ArchiveSource(
      botaneItem.templateId,
      "presentation-template/botane-organic",
    );
  });
});
