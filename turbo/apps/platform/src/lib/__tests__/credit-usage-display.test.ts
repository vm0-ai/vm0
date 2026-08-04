import { beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_LOCALE, initializeI18n } from "../../i18n/index.ts";
import { getCreditUsageDisplayName } from "../credit-usage-display.ts";

describe("getCreditUsageDisplayName", () => {
  beforeAll(async () => {
    await initializeI18n(DEFAULT_LOCALE);
  });

  it("labels image recognition usage with a user-facing name", () => {
    expect(
      getCreditUsageDisplayName("model", "google/gemini-3.5-flash"),
    ).toBe("Image Recognize");
  });

  it("keeps friendly names for regular chat models", () => {
    expect(getCreditUsageDisplayName("model", "gpt-5.6-sol")).toBe(
      "GPT 5.6 Sol",
    );
  });

  it("formats unknown providers as a readable label", () => {
    expect(getCreditUsageDisplayName("model", "acme/vision-pro")).toBe(
      "Acme Vision Pro",
    );
  });
});
