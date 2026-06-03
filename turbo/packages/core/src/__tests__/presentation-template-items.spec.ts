import { describe, expect, it } from "vitest";
import { PRESENTATION_TEMPLATE_ITEMS } from "../presentation-template-items";
import { findDesignSystem, findTemplate } from "../resource-registry";

function stripRegistryPrefix(id: string, prefix: string): string {
  expect(id.startsWith(prefix)).toBe(true);
  return id.slice(prefix.length);
}

describe("presentation template items", () => {
  it("resolve every design system and template against the resource registry", () => {
    for (const item of PRESENTATION_TEMPLATE_ITEMS) {
      const designSystem = findDesignSystem(item.designSystemId);
      const template = findTemplate(item.templateId);

      expect(designSystem, item.designSystemId).toBeDefined();
      expect(template, item.templateId).toBeDefined();
      expect(template?.targets).toContain("presentation");
    }
  });

  it("keeps prompt references aligned with structured ids", () => {
    for (const item of PRESENTATION_TEMPLATE_ITEMS) {
      const promptDesignSystem = stripRegistryPrefix(
        item.designSystemId,
        "design-system:",
      );
      const promptTemplate = stripRegistryPrefix(item.templateId, "template:");

      expect(item.prompt).toContain(`design system \`${promptDesignSystem}\``);
      expect(item.prompt).toContain(`template \`${promptTemplate}\``);
    }
  });
});
