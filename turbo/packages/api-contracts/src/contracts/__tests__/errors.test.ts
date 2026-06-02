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

  it("appends Add credits link for admins on insufficient credits", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits. Please add credits to continue.",
        insufficientCredits: {
          canManageBilling: true,
          addCreditsUrl:
            "https://app.example.test/?settings=billing&billingView=credits",
        },
      }),
    ).toBe(
      "Insufficient credits. Please add credits to continue.\n\nAdd credits: https://app.example.test/?settings=billing&billingView=credits",
    );
  });

  it("asks non-admins to contact an admin on insufficient credits", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits. Please add credits to continue.",
        insufficientCredits: {
          canManageBilling: false,
          addCreditsUrl:
            "https://app.example.test/?settings=billing&billingView=credits",
        },
      }),
    ).toBe(INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE);
  });

  it("shows Codex usage limit errors verbatim", () => {
    const codexUsageLimit =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 6:17 AM.";
    const formatted = formatRunErrorForExternalSurface({
      code: "UNKNOWN",
      message: codexUsageLimit,
    });
    expect(formatted).toBe(codexUsageLimit);
    expect(formatted).not.toContain("switch to another model");
  });

  it("shows Claude session limit errors verbatim", () => {
    const sessionLimit =
      "You've hit your session limit · resets 12:50pm (Asia/Shanghai)";
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: sessionLimit,
      }),
    ).toBe(sessionLimit);
  });

  it("shows Claude weekly limit errors verbatim", () => {
    const weeklyLimit =
      "You've hit your weekly limit · resets 10am (Asia/Shanghai)";
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: weeklyLimit,
      }),
    ).toBe(weeklyLimit);
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
