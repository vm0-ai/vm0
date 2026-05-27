import { describe, expect, it } from "vitest";

import {
  formatRunErrorForExternalSurface,
  INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE,
} from "../errors";

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

  it("appends Compare plans link for admins on insufficient credits", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits. Please add credits to continue.",
        insufficientCredits: {
          canManageBilling: true,
          comparePlansUrl:
            "https://app.example.test/?settings=billing&billingView=plans",
        },
      }),
    ).toBe(
      "Insufficient credits. Please add credits to continue.\n\nCompare plans: https://app.example.test/?settings=billing&billingView=plans",
    );
  });

  it("asks non-admins to contact an admin on insufficient credits", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits. Please add credits to continue.",
        insufficientCredits: {
          canManageBilling: false,
          comparePlansUrl:
            "https://app.example.test/?settings=billing&billingView=plans",
        },
      }),
    ).toBe(INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE);
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
