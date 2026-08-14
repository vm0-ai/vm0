import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { getCategories } from "../zero-ideation-data.ts";

function zapierMigrationPrompt(brandName?: "VM0" | "Okou"): string {
  const categories = getCategories({
    ...(brandName ? { brandName } : {}),
    features: { [FeatureSwitchKey.ZapierConnector]: true },
  });
  const migration = categories
    .flatMap((category) => {
      return category.cases;
    })
    .find((useCase) => {
      return useCase.id === "zapier-vm0-migration";
    });
  if (!migration) {
    throw new Error("Zapier migration use case is missing");
  }
  return migration.prompt;
}

describe("zero ideation data branding", () => {
  it("uses Okou as the migration target for the Okou app", () => {
    expect(zapierMigrationPrompt("Okou")).toContain(
      "migrate my Zapier workflows to Okou",
    );
  });

  it("preserves VM0 as the default migration target", () => {
    expect(zapierMigrationPrompt()).toContain(
      "migrate my Zapier workflows to VM0",
    );
  });
});
