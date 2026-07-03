import { describe, expect, it } from "vitest";

import { isDesktopSmokeTestEnabled } from "./desktop-smoke-test";

describe("isDesktopSmokeTestEnabled", () => {
  it("enables smoke test mode only when the flag is exactly 1", () => {
    expect(isDesktopSmokeTestEnabled({ VM0_DESKTOP_SMOKE_TEST: "1" })).toBe(
      true,
    );
    expect(isDesktopSmokeTestEnabled({ VM0_DESKTOP_SMOKE_TEST: "true" })).toBe(
      false,
    );
    expect(isDesktopSmokeTestEnabled({ VM0_DESKTOP_SMOKE_TEST: "" })).toBe(
      false,
    );
    expect(isDesktopSmokeTestEnabled({})).toBe(false);
  });
});
