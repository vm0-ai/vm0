import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
} from "@vm0/core";
import { describe, expect, it } from "vitest";
import {
  serializeInlineFilePromptItem,
  serializeInlineTemplatePromptItem,
  splitInlinePromptLine,
} from "../composer-inline-prompt-items.ts";

describe("composer inline prompt items", () => {
  it("serializes and restores a template from the current registry", () => {
    const template = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const serialized = serializeInlineTemplatePromptItem({
      type: "illustration",
      selectionId: template.illustrationStyleId,
    });

    expect(serialized).toContain(
      `${template.title}<!-- zero-template:v1 type="illustration"`,
    );
    expect(serialized).toContain(
      `zero generate image --provider built-in --style ${template.illustrationStyleId}`,
    );
    expect(splitInlinePromptLine(`Draw ${serialized} now`)).toStrictEqual([
      { type: "text", text: "Draw " },
      expect.objectContaining({
        type: "template",
        template: expect.objectContaining({
          title: template.title,
          request: {
            type: "illustration",
            selection: {
              illustrationStyleId: template.illustrationStyleId,
            },
          },
        }),
      }),
      { type: "text", text: " now" },
    ]);
  });

  it("keeps unknown template comments visible as text", () => {
    const serialized =
      'Unknown<!-- zero-template:v1 type="illustration" id="image-style:unknown"; hidden -->';

    expect(splitInlinePromptLine(serialized)).toStrictEqual([
      { type: "text", text: serialized },
    ]);
  });

  it("restores vm0 artifact links as files without consuming normal links", () => {
    const fileUrl =
      "https://cdn.vm0.io/artifacts/user_1/upload_1/launch-notes.pdf";
    const file = serializeInlineFilePromptItem("launch[final].pdf", fileUrl);
    const line = `${file} and [docs](https://example.com/docs)`;

    expect(file).toBe(`[launch\\[final\\].pdf](${fileUrl})`);
    expect(splitInlinePromptLine(line)).toStrictEqual([
      {
        type: "file",
        filename: "launch[final].pdf",
        url: fileUrl,
      },
      { type: "text", text: " and [docs](https://example.com/docs)" },
    ]);
  });

  it("preserves the selected presentation color system", () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const serialized = serializeInlineTemplatePromptItem({
      type: "presentation",
      selectionId: template.templateId,
      colorSystemId: "color-system:carnival",
    });

    expect(serialized).toContain('color="color-system:carnival"');
    expect(splitInlinePromptLine(serialized)[0]).toMatchObject({
      type: "template",
      template: {
        request: {
          type: "presentation",
          selection: {
            templateId: template.templateId,
            colorSystemId: "color-system:carnival",
          },
        },
      },
    });
  });
});
