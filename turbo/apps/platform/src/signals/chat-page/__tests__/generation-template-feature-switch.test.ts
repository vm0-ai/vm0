import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";
import { generationTemplateForFeatureSwitches } from "../generation-template-feature-switch.ts";

describe("generationTemplateForFeatureSwitches", () => {
  it("keeps website templates when inline prompt items are off", () => {
    const template: GenerationTemplateRequest = {
      type: "website",
      selection: { websiteTemplateId: "warm-cards" },
    };

    expect(generationTemplateForFeatureSwitches(template, {})).toBe(template);
  });

  it("drops structured templates when inline prompt items are on", () => {
    const template: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: "image-style:ink-studio" },
    };

    expect(
      generationTemplateForFeatureSwitches(template, {
        [FeatureSwitchKey.ComposerInlinePromptItems]: true,
      }),
    ).toBeUndefined();
  });
});
