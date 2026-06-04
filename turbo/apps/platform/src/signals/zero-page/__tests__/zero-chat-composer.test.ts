import { describe, expect, it } from "vitest";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  newThreadGenerationTemplate$,
  setNewThreadGenerationTemplate$,
  setTemplatePickerCategory$,
  setTemplatePickerOpen$,
  setThreadGenerationTemplate$,
  templatePickerCategory$,
  templatePickerOpen$,
  threadGenerationTemplate$,
} from "../zero-chat-composer.ts";

const context = testContext();

function createGenerationTemplate(): GenerationTemplateRequest {
  return {
    type: "presentation",
    selection: {
      designSystemId: "design-system-test",
      templateId: "template:html-ppt-pitch-deck",
    },
  };
}

describe("zero chat composer signals", () => {
  it("stores template picker dialog state", () => {
    expect(context.store.get(templatePickerOpen$)).toBeFalsy();
    expect(context.store.get(templatePickerCategory$)).toBe("slides");

    context.store.set(setTemplatePickerOpen$, true);
    context.store.set(setTemplatePickerCategory$, "website");

    expect(context.store.get(templatePickerOpen$)).toBeTruthy();
    expect(context.store.get(templatePickerCategory$)).toBe("website");
  });

  it("stores generation template selections", () => {
    const generationTemplate = createGenerationTemplate();

    expect(context.store.get(newThreadGenerationTemplate$)).toBeUndefined();
    expect(context.store.get(threadGenerationTemplate$)).toBeNull();

    context.store.set(setNewThreadGenerationTemplate$, generationTemplate);
    context.store.set(
      setThreadGenerationTemplate$,
      "thread-template-picker",
      generationTemplate,
    );

    expect(context.store.get(newThreadGenerationTemplate$)).toStrictEqual(
      generationTemplate,
    );
    expect(context.store.get(threadGenerationTemplate$)).toStrictEqual({
      threadId: "thread-template-picker",
      value: generationTemplate,
    });
  });
});
