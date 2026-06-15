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

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") {
      return;
    }
    // Surfaces the attached style as user context...
    expect(result.prompt).toContain(
      `Image style ID: ${item.illustrationStyleId}`,
    );
    expect(result.prompt).toContain("# User context");
    // ...describes the likely intent so the agent does not re-ask for a style
    // the user already selected (vm0-ai/vm0#17525)...
    expect(result.prompt).toContain("# Likely intent");
    // ...and gives the concrete capability fact: the style id feeds
    // `zero generate image --style`.
    expect(result.prompt).toContain(
      `zero generate image --style ${item.illustrationStyleId}`,
    );
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
