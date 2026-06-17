import { describe, expect, it } from "vitest";
import {
  PRESENTATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
} from "../presentation-template-items";
import { findDesignSystem, findTemplate } from "../resource-registry";

function stripRegistryPrefix(id: string, prefix: string): string {
  expect(id.startsWith(prefix)).toBe(true);
  return id.slice(prefix.length);
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
    expect(item?.designSystemId).toBe("design-system:playful-editorial");
    expect(item?.templateId).toBe("template:html-ppt-playful-launch");
    expect(item?.previewImages.length).toBe(15);
    expect(item?.previewImage).toBe(item?.previewImages[0]);
    expect(
      item?.previewImages.every((url) => {
        return url.startsWith("https://cdn.vm0.io/artifacts/");
      }),
    ).toBe(true);
    expect(findDesignSystem(item?.designSystemId ?? "")).toBeDefined();
    expect(findTemplate(item?.templateId ?? "")?.targets).toContain(
      "presentation",
    );

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
    for (const previewUrl of botaneItem.previewImages) {
      expect(previewUrl).toMatch(/^https:\/\/cdn\.vm0\.io\//);
      expect(previewUrl).not.toMatch(
        /drive\.google\.com|googleusercontent\.com|raw\.githubusercontent\.com|file:\/\//,
      );
    }
    expect(findDesignSystem(botaneItem.designSystemId)).toBeDefined();
    expect(findTemplate(botaneItem.templateId)?.targets).toContain(
      "presentation",
    );
  });
});
