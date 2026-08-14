import { beforeAll, describe, expect, it } from "vitest";

import { i18n, initializeI18n } from "../../../i18n/index.ts";
import { DEFAULT_LOCALE } from "../../../i18n/resources.ts";
import {
  buildCustomWorkflowPrompt,
  findOnboardingWorkflow,
} from "../onboarding-data.ts";

beforeAll(async () => {
  await initializeI18n(DEFAULT_LOCALE);
});

describe("onboarding assistant branding", () => {
  it("brands Platform-owned and core workflow prompts for Okou", () => {
    const supplemental = findOnboardingWorkflow(
      "morning-brief-slack",
      i18n.t,
      "Okou",
    );
    const core = findOnboardingWorkflow(
      "auto-merge-github-prs",
      i18n.t,
      "Okou",
    );

    expect(supplemental?.prompt).toContain("@Okou send me a brief");
    expect(core?.prompt).toContain("Okou reviews and waits on CI");
    expect(supplemental?.prompt).not.toContain("Zero");
    expect(core?.prompt).not.toContain("Zero");
  });

  it("uses the domain assistant for a custom prompt without rewriting a user mention", () => {
    expect(buildCustomWorkflowPrompt("Build a daily brief", "Okou")).toBe(
      "@Okou Build a daily brief",
    );
    expect(buildCustomWorkflowPrompt("@Researcher build a brief", "Okou")).toBe(
      "@Researcher build a brief",
    );
  });
});
