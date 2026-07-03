import { describe, expect, it } from "vitest";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WORKFLOW_TEMPLATE_ITEMS,
} from "@vm0/core";
import { buildGenerationTemplatePrompt } from "../generation-template-prompt";

describe("buildGenerationTemplatePrompt", () => {
  it("returns invalid for a presentation template without a runbook package", () => {
    // Presentations are runbook-only. Legacy `template:html-ppt-*` /
    // `design-system:*` entries are retired, so a demo-catalog template id no
    // longer resolves to a generation prompt.
    const item = PRESENTATION_TEMPLATE_ITEMS[0]!;

    const result = buildGenerationTemplatePrompt({
      type: "presentation",
      selection: {
        designSystemId: item.designSystemId,
        templateId: item.templateId,
        previewUrl: item.embedUrl,
      },
    });

    expect(result.status).toBe("invalid");
  });

  it("builds runbook presentation guidance for a template that ships a runbook package", () => {
    const item = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;

    const result = buildGenerationTemplatePrompt({
      type: "presentation",
      selection: {
        colorSystemId: item.colorSystemId,
        designSystemId: item.designSystemId,
        templateId: item.templateId,
      },
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain("# Artifact Template Context");
    // Pull exactly one resource: the template's runbook package.
    expect(result.prompt).toContain(
      "zero resource pull template:html-ppt-playful-launch-runbook --dir ./generated/resources",
    );
    expect(result.prompt).toContain(
      "./generated/resources/playful-launch/AGENT_RUNBOOK.md",
    );
    // Color system is a runtime token in the deck JSON.
    expect(result.prompt).toContain('"colorSystem": "carnival"');
    expect(result.prompt).toContain(
      "zero host <output-dir> --site <slug> --artifact-kind presentation-html",
    );
    // The runbook flow has no design system and does not use `zero generate`.
    expect(result.prompt).not.toContain("Design system:");
    expect(result.prompt).not.toContain("zero generate presentation");
  });

  it("falls back to the default color token when none is selected", () => {
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
    // playful-launch default color token.
    expect(result.prompt).toContain('"colorSystem": "carnival"');
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
});
