import { describe, expect, it } from "vitest";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_ITEMS,
  VIDEO_STYLE_PRESETS,
} from "@vm0/core";
import { buildGenerationTemplatePrompt } from "../generation-template-prompt";

describe("buildGenerationTemplatePrompt", () => {
  it("builds presentation template guidance", () => {
    const item = PRESENTATION_TEMPLATE_ITEMS[0]!;

    const result = buildGenerationTemplatePrompt({
      type: "presentation",
      selection: {
        designSystemId: item.designSystemId,
        templateId: item.templateId,
      },
    });

    expect(result).toStrictEqual({
      status: "resolved",
      prompt: expect.stringContaining(`Template ID: ${item.templateId}`),
    });
  });

  it("builds illustration template guidance", () => {
    const item = ILLUSTRATION_TEMPLATE_ITEMS[0]!;

    const result = buildGenerationTemplatePrompt({
      type: "illustration",
      selection: {
        illustrationStyleId: item.illustrationStyleId,
      },
    });

    expect(result).toStrictEqual({
      status: "resolved",
      prompt: expect.stringContaining(
        `Image style ID: ${item.illustrationStyleId}`,
      ),
    });
  });

  it("builds video template preset guidance", () => {
    const item = VIDEO_STYLE_PRESETS[0]!;

    const result = buildGenerationTemplatePrompt({
      type: "video",
      selection: {
        stylePresetId: item.id,
      },
    });

    expect(result).toStrictEqual({
      status: "resolved",
      prompt: expect.stringContaining("# Video Template Preset"),
    });
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain(`Preset ID: ${item.id}`);
    expect(result.prompt).toContain(`Preset name: ${item.nameEn}`);
    expect(result.prompt).toContain(
      "Apply all dimensions and constraints below as hard generation constraints.",
    );
    expect(result.prompt).toContain("- Visual Tone:");
    expect(result.prompt).toContain("- Camera Style:");
    expect(result.prompt).toContain("- Editing Pace:");
    expect(result.prompt).toContain("- Narrative Mode:");
    expect(result.prompt).toContain("- Production Type:");
    expect(result.prompt).toContain("- Emotional Tone:");
    expect(result.prompt).toContain("- Style Reference:");
    expect(result.prompt).toContain(
      "- Style constraints (inject into the video prompt):",
    );
    expect(result.prompt).toContain(
      `reflect every dimension and constraint above for the style ${item.nameEn}`,
    );
  });
});
