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

  for (const url of [item.previewImage, item.embedUrl, ...item.previewImages]) {
    for (const forbidden of FORBIDDEN_ASSET_URL_PARTS) {
      expect(url).not.toContain(forbidden);
    }
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

    expect(item.designSystemId).toBe("design-system:berry-pop");
    expect(item.templateId).toBe("template:html-ppt-business-data");
    expect(item.previewImages.length).toBe(15);
    expect(item.embedUrl).toMatch(
      /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/example\.html$/,
    );
    expectCdnPreviewImages(item);
    expect(findDesignSystem(item.designSystemId)).toBeDefined();
    expect(findTemplate(item.templateId)?.targets).toContain("presentation");
    expectR2ArchiveSource(
      item.designSystemId,
      "presentation-design-system/berry-pop",
    );
    expectR2ArchiveSource(
      item.templateId,
      "presentation-template/business-data",
    );
  });

  it("keeps the botane picker item aligned with CDN assets", () => {
    const botaneItem = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
      return candidate.slug === "botane-organic-deck";
    });

    expect(botaneItem).toBeDefined();
    if (!botaneItem) {
      throw new Error("Botane picker item is missing");
    }
    expect(botaneItem.designSystemId).toBe("design-system:mauve-dusk");
    expect(botaneItem.templateId).toBe("template:html-ppt-botane-organic");
    expect(botaneItem.previewImages.length).toBe(15);
    expect(botaneItem.previewImage).toBe(botaneItem.previewImages[0]);
    expect(botaneItem.embedUrl).toMatch(/^https:\/\/cdn\.vm0\.io\/.+\.html$/);
    expectCdnPreviewImages(botaneItem);
    expect(findDesignSystem(botaneItem.designSystemId)).toBeDefined();
    expect(findTemplate(botaneItem.templateId)?.targets).toContain(
      "presentation",
    );
    expectR2ArchiveSource(
      botaneItem.designSystemId,
      "presentation-design-system/mauve-dusk",
    );
    expectR2ArchiveSource(
      botaneItem.templateId,
      "presentation-template/botane-organic",
    );
  });
});
