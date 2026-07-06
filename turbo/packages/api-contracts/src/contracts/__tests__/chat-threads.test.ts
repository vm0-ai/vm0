import { describe, expect, it } from "vitest";

import { generationTemplateRequestSchema } from "../chat-threads";

describe("chat thread generation template contract", () => {
  it("accepts presentation runbook selections", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "presentation",
      selection: {
        runbookId: "presentation-runbook:playful-launch",
        colorSystemId: "color-system:carnival",
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects legacy presentation design-system/template selections", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "presentation",
      selection: {
        designSystemId: "design-system:playful-editorial",
        templateId: "template:html-ppt-playful-launch",
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts workflow template selections", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "workflow",
      selection: {
        workflowTemplateId: "workflow-template:auto-inbox-label",
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects empty workflow template ids", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "workflow",
      selection: { workflowTemplateId: "" },
    });

    expect(parsed.success).toBe(false);
  });
});
