import { describe, expect, it } from "vitest";

import { formatRunErrorForExternalSurface } from "../errors";

describe("formatRunErrorForExternalSurface", () => {
  it("preserves allowlisted run errors like Web chat", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "NO_MODEL_PROVIDER",
        message: "No model provider configured",
      }),
    ).toBe("No model provider configured");
  });

  it("preserves non-guidance allowlisted run errors", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: "Cannot continue session with this provider",
      }),
    ).toBe("Cannot continue session with this provider");
  });

  it("preserves ChatGPT Codex usage limit guidance", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message:
          "ChatGPT Codex usage limit reached. Visit chatgpt.com/codex/settings/usage.",
      }),
    ).toContain("ChatGPT Codex usage limit reached.");
  });

  it("falls back to the Web generic message for unallowlisted errors", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: "Something failed",
      }),
    ).toBe("Oops, something went wrong. Please try again later.");
  });
});
