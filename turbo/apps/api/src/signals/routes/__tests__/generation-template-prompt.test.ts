import { describe, expect, it } from "vitest";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
  WORKFLOW_TEMPLATE_ITEMS,
} from "@vm0/core";
import { findImageStyle } from "@vm0/core/resource-registry";
import { buildGenerationTemplatePrompt } from "../generation-template-prompt";

describe("buildGenerationTemplatePrompt", () => {
  it("returns invalid for a presentation selection without a runbook package", () => {
    // Presentations are runbook-only. Retired demo-catalog selections no longer
    // resolve to generation prompts.
    const result = buildGenerationTemplatePrompt({
      type: "presentation",
      selection: {
        templateId: "template:html-ppt-missing",
        previewUrl: "https://example.com/retired.html",
      },
    });

    expect(result.status).toBe("invalid");
  });

  it("builds runbook presentation guidance for a selected runbook package", () => {
    const item = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;

    const result = buildGenerationTemplatePrompt({
      type: "presentation",
      selection: {
        templateId: item.templateId,
        colorSystemId: item.colorSystemId,
      },
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain("# Artifact Template Context");
    expect(result.prompt).toContain(
      "Selected presentation template: Playful Launch Presentation (template:html-ppt-playful-launch)",
    );
    // Pull exactly one resource: the selected runbook package.
    expect(result.prompt).toContain(
      "zero resource pull template:html-ppt-playful-launch-runbook --dir ./generated/resources",
    );
    expect(result.prompt).toContain(
      "./generated/resources/playful-launch/AGENT_RUNBOOK.md",
    );
    // Color system is a runtime token in the deck JSON.
    expect(result.prompt).toContain('"colorSystem": "carnival"');
    expect(result.prompt).toContain(
      "all user-visible slide content, with the first slide visible before JavaScript runs",
    );
    expect(result.prompt).toContain(
      "Do not store slide content in JavaScript data",
    );
    expect(result.prompt).toContain(
      "zero host <output-dir> --site <slug> --artifact-kind presentation-html",
    );
    // The runbook flow has no design system and does not use `zero generate`.
    expect(result.prompt).not.toContain("Design system:");
    expect(result.prompt).not.toContain("Selected design system");
    expect(result.prompt).not.toContain("zero generate presentation");
  });

  it("falls back to the default color token when none is selected", () => {
    const item = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;

    const result = buildGenerationTemplatePrompt({
      type: "presentation",
      selection: {
        templateId: item.templateId,
      },
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") {
      return;
    }
    // playful-launch default color token.
    expect(result.prompt).toContain('"colorSystem": "carnival"');
  });

  it("builds illustration template guidance", () => {
    const item = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const imageStyle = findImageStyle(item.illustrationStyleId)!;

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
      `- Style description: ${imageStyle.description}`,
    );
    expect(result.prompt).toContain(
      `zero generate image --provider built-in --style ${item.illustrationStyleId} --prompt "<user request>" --compile`,
    );
    expect(result.prompt).toContain("Style source: vm0-ai/vm0-skills@main:");
    expect(result.prompt).toContain("Follow the returned packet completely");
    expect(result.prompt).toContain(
      "If the source is unavailable, stop without generating",
    );
    expect(result.prompt).toContain("--compiled-prompt");
    expect(result.prompt).toContain("resolved compatible CLI options");
    expect(result.prompt).toContain("required reference image URLs");
  });

  it("builds video template preset guidance", () => {
    const item = VIDEO_TEMPLATE_ITEMS[0]!;

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
    expect(result.prompt).toContain(`Template: ${item.title} (${item.id})`);
    expect(result.prompt).toContain(
      `Template source: vm0-ai/vm0-skills@main:${item.sourcePath}`,
    );
    expect(result.prompt).not.toContain("nexu-io/open-design");
    expect(result.prompt).toContain(
      `zero generate video --provider built-in --template ${item.id}`,
    );
    expect(result.prompt).toContain(
      "Run once to fetch the locked video authoring packet",
    );
    expect(result.prompt).toContain(
      "read its SKILL.md before final generation",
    );
    expect(result.prompt).toContain("without `--template`");
  });

  it("builds workflow template guidance", () => {
    const item = WORKFLOW_TEMPLATE_ITEMS[0]!;

    const result = buildGenerationTemplatePrompt({
      type: "workflow",
      selection: {
        workflowTemplateId: item.id,
      },
    });

    expect(result).toStrictEqual({
      status: "resolved",
      prompt: item.promptGuidance,
    });
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain("# Workflow Template Context");
    expect(result.prompt).toContain(`Auto-inbox label (${item.id})`);
    expect(result.prompt).toContain("Use the workflow-setup skill");
    expect(result.prompt).toContain("Gmail label-applied automation");
    expect(result.prompt).not.toContain("# Artifact Template Context");
  });

  it("builds website template package guidance", () => {
    const item = WEBSITE_TEMPLATE_ITEMS[0]!;

    const result = buildGenerationTemplatePrompt({
      type: "website",
      selection: {
        websiteTemplateId: item.id,
      },
    });

    expect(result).toStrictEqual({
      status: "resolved",
      prompt: expect.stringContaining("# Artifact Template Context"),
    });
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain(`Template: ${item.title} (${item.id})`);
    expect(result.prompt).toContain(`Template package id: ${item.templateId}`);
    expect(result.prompt).toContain(`Package resource: ${item.resourceId}`);
    expect(result.prompt).toContain(
      `zero resource pull ${item.resourceId} --dir ./generated/resources`,
    );
    expect(result.prompt).toContain(
      `./generated/resources/${item.sourcePath}/resolve-images.mjs`,
    );
    expect(result.prompt).toContain("/api/presentation/images/resolve");
    expect(result.prompt).toContain(
      `./generated/resources/${item.sourcePath}/render.mjs`,
    );
    expect(result.prompt).toContain("zero host <output-dir> --site <slug>");
    expect(result.prompt).toContain("built-in R2-backed package");
    expect(result.prompt).not.toContain("zero generate website --template");
  });

  it("selects every additive v2 package behind the rollout switch", () => {
    for (const item of WEBSITE_TEMPLATE_ITEMS) {
      const resourceId = `${item.resourceId}-v2`;
      const result = buildGenerationTemplatePrompt(
        {
          type: "website",
          selection: {
            websiteTemplateId: item.id,
          },
        },
        { websiteTemplateV2Enabled: true },
      );

      expect(result).toStrictEqual({
        status: "resolved",
        prompt: expect.stringContaining(
          `zero resource pull ${resourceId} --dir ./generated/resources`,
        ),
      });
      if (result.status !== "resolved") {
        continue;
      }
      expect(result.prompt).toContain(`Template package id: ${resourceId}`);
      expect(result.prompt).toContain(`Package resource: ${resourceId}`);
      expect(result.prompt).toContain(
        `./generated/resources/${item.sourcePath}/render.mjs`,
      );
    }
  });

  it("rejects unknown workflow templates", () => {
    const result = buildGenerationTemplatePrompt({
      type: "workflow",
      selection: {
        workflowTemplateId: "workflow-template:missing",
      },
    });

    expect(result).toStrictEqual({
      status: "invalid",
      message: "Unknown workflow template",
    });
  });

  it("rejects unknown website templates", () => {
    const result = buildGenerationTemplatePrompt({
      type: "website",
      selection: {
        websiteTemplateId: "website-template:missing",
      },
    });

    expect(result).toStrictEqual({
      status: "invalid",
      message: "Unknown website template",
    });
  });
});
