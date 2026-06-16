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

  it("keeps the picker catalog separate from the legacy catalog", () => {
    expect(
      PRESENTATION_TEMPLATE_ITEMS.some((candidate) => {
        return candidate.slug === "tomorrow-lab-playful-deck";
      }),
    ).toBe(false);

    const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
      return candidate.slug === "tomorrow-lab-playful-deck";
    });

    expect(item).toBeDefined();
    expect(item?.designSystemId).toBe("design-system:playful-editorial");
    expect(item?.templateId).toBe("template:html-ppt-aplocoto");
    expect(item?.previewImages.length).toBe(15);
    expect(findDesignSystem(item?.designSystemId ?? "")).toBeDefined();
    expect(findTemplate(item?.templateId ?? "")?.targets).toContain(
      "presentation",
    );
  });
});
