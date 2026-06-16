import { describe, expect, it } from "vitest";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
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

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain("# Artifact Template Context");
    expect(result.prompt).toContain(
      "The user deliberately selected this artifact template",
    );
    expect(result.prompt).toContain(
      "It does not force you to generate: the user's prompt decides the task",
    );
    expect(result.prompt).toContain(`(${item.designSystemId})`);
    expect(result.prompt).toContain(`(${item.templateId})`);
    expect(result.prompt).toContain(
      `zero generate presentation --design-system ${item.designSystemId} --template ${item.templateId}`,
    );
  });

  it("builds presentation template guidance for the switched picker catalog", () => {
    const item = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;

    const result = buildGenerationTemplatePrompt({
      type: "presentation",
      selection: {
        designSystemId: item.designSystemId,
        templateId: item.templateId,
      },
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain("Playful Editorial");
    expect(result.prompt).toContain(`(${item.designSystemId})`);
    expect(result.prompt).toContain(`(${item.templateId})`);
    expect(result.prompt).toContain(
      `zero generate presentation --design-system ${item.designSystemId} --template ${item.templateId}`,
    );
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
    expect(result.prompt).toContain("# Artifact Template Context");
    // States the attached style and the exact command that applies it, so the
    // agent does not re-ask for an already-selected style (vm0-ai/vm0#17525).
    expect(result.prompt).toContain(item.illustrationStyleId);
    expect(result.prompt).toContain(
      `zero generate image --provider built-in --style ${item.illustrationStyleId}`,
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
      prompt: expect.stringContaining("# Artifact Template Context"),
    });
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain(`Preset: ${item.nameEn} (${item.id})`);
    expect(result.prompt).toContain("- Visual tone:");
    expect(result.prompt).toContain("- Camera style:");
    expect(result.prompt).toContain("- Editing pace:");
    expect(result.prompt).toContain("- Narrative mode:");
    expect(result.prompt).toContain("- Production type:");
    expect(result.prompt).toContain("- Emotional tone:");
    expect(result.prompt).toContain("- Style reference:");
    expect(result.prompt).toContain("- Prompt style notes:");
    expect(result.prompt).toContain(
      "Reflect the style dimensions and prompt notes above in the final video prompt.",
    );
    // The content-safety guardrail is the only video moderation in the repo, so
    // it must survive every rewrite of this prompt.
    expect(result.prompt).toContain(
      "safe for all audiences, positive and uplifting, no violence, no explicit content",
    );
    expect(result.prompt).toContain(
      "zero generate video --provider built-in --prompt",
    );
  });
});
