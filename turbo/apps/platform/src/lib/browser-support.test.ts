import { describe, expect, it } from "vitest";

import { browserUpgradeForUserAgent } from "./browser-support.ts";

describe("browser support", () => {
  it.each([
    {
      actionUrl: "https://support.apple.com/HT204204",
      target: "ios",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 Version/16.3 Mobile/15E148 Safari/604.1",
    },
    {
      actionUrl: "https://www.google.com/chrome/",
      target: "chrome",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/110.0.0.0 Safari/537.36",
    },
    {
      actionUrl: "https://www.chromium.org/getting-involved/download-chromium/",
      target: "chromium",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chromium/110.0.0.0 Safari/537.36",
    },
    {
      actionUrl: "https://support.apple.com/safari",
      target: "safari",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_2) AppleWebKit/605.1.15 Version/16.3 Safari/605.1.15",
    },
  ] as const)(
    "returns the $target upgrade from the app bundle",
    ({ actionUrl, target, userAgent }) => {
      expect(browserUpgradeForUserAgent(userAgent)).toStrictEqual({
        actionUrl,
        target,
      });
    },
  );

  it.each([
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 Version/16.4 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/111.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chromium/111.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_3) AppleWebKit/605.1.15 Version/16.4 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/110.0.0.0 Safari/537.36 Edg/110.0.0.0",
    "unknown-browser",
  ])("allows a supported or unclassified browser", (userAgent) => {
    expect(browserUpgradeForUserAgent(userAgent)).toBeNull();
  });
});
