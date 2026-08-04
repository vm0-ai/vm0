import { beforeAll, describe, expect, it } from "vitest";

import { initializeI18n } from "../../i18n/index.ts";
import { DEFAULT_LOCALE } from "../../i18n/resources.ts";
import { getCreditUsageDisplayName } from "../credit-usage-display.ts";

describe("getCreditUsageDisplayName", () => {
  beforeAll(async () => {
    await initializeI18n(DEFAULT_LOCALE);
  });

  it("labels image task kinds with a user-facing name", () => {
    expect(
      getCreditUsageDisplayName("image-recognition", "google/gemini-3.5-flash"),
    ).toBe("Image Recognize");
    expect(
      getCreditUsageDisplayName(
        "image-interpret-marks",
        "google/gemini-3.5-flash",
      ),
    ).toBe("Image Recognize");
  });

  it("labels the task even if a different model backs it later", () => {
    expect(
      getCreditUsageDisplayName("image-recognition", "acme/vision-pro"),
    ).toBe("Image Recognize");
  });

  it("labels pre-task-kind model rows recorded for image recognition", () => {
    expect(getCreditUsageDisplayName("model", "google/gemini-3.5-flash")).toBe(
      "Image Recognize",
    );
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
