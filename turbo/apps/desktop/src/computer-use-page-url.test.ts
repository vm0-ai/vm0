import { describe, expect, it } from "vitest";
import { isDesktopComputerUsePageUrl } from "./computer-use-page-url";

const ALLOWED_ORIGINS = new Set([
  "https://app.vm0.ai",
  "http://localhost:3000",
]);

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
      isDesktopComputerUsePageUrl("https://app.vm0.ai/agents", ALLOWED_ORIGINS),
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
