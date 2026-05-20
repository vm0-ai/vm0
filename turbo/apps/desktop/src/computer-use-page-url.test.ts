import { describe, expect, it } from "vitest";
import {
  buildDesktopComputerUsePageUrl,
  isDesktopComputerUsePageUrl,
} from "./computer-use-page-url";

const ALLOWED_ORIGINS = new Set([
  "https://app.vm0.ai",
  "http://localhost:3000",
]);

describe("buildDesktopComputerUsePageUrl", () => {
  it("builds a platform Computer Use page URL", () => {
    expect(buildDesktopComputerUsePageUrl(new URL("https://app.vm0.ai"))).toBe(
      "https://app.vm0.ai/computer-use",
    );
    expect(
      buildDesktopComputerUsePageUrl(
        new URL("http://localhost:3000/settings?tab=computer"),
      ),
    ).toBe("http://localhost:3000/computer-use");
  });
});

describe("isDesktopComputerUsePageUrl", () => {
  it("allows the desktop Computer Use page from configured app origins", () => {
    expect(
      isDesktopComputerUsePageUrl(
        "https://app.vm0.ai/computer-use",
        ALLOWED_ORIGINS,
      ),
    ).toBe(true);
    expect(
      isDesktopComputerUsePageUrl(
        "http://localhost:3000/computer-use/",
        ALLOWED_ORIGINS,
      ),
    ).toBe(true);
  });

  it("rejects other pages and origins", () => {
    expect(
      isDesktopComputerUsePageUrl(
        "https://app.vm0.ai/local-agents",
        ALLOWED_ORIGINS,
      ),
    ).toBe(false);
    expect(
      isDesktopComputerUsePageUrl(
        "https://evil.example/computer-use",
        ALLOWED_ORIGINS,
      ),
    ).toBe(false);
    expect(isDesktopComputerUsePageUrl("not a url", ALLOWED_ORIGINS)).toBe(
      false,
    );
  });
});
