import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";
import { generationTemplateForFeatureSwitches } from "../generation-template-feature-switch.ts";

describe("generationTemplateForFeatureSwitches", () => {
  it("keeps non-website templates independent of the website switch", () => {
    const template: GenerationTemplateRequest = {
      type: "workflow",
      selection: { workflowTemplateId: "workflow:auto-inbox" },
    };

    expect(generationTemplateForFeatureSwitches(template, {})).toBe(template);
  });

  it("drops website templates when the website template switch is off", () => {
    const template: GenerationTemplateRequest = {
      type: "website",
      selection: { websiteTemplateId: "warm-cards" },
    };

    expect(
      generationTemplateForFeatureSwitches(template, {
        [FeatureSwitchKey.WebsiteTemplates]: false,
      }),
    ).toBeUndefined();
  });

  it("keeps website templates when the website template switch is on", () => {
    const template: GenerationTemplateRequest = {
      type: "website",
      selection: { websiteTemplateId: "warm-cards" },
    };

    expect(
      generationTemplateForFeatureSwitches(template, {
        [FeatureSwitchKey.WebsiteTemplates]: true,
      }),
    ).toBe(template);
  });
});
