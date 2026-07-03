import { describe, expect, it } from "vitest";
import { isDesktopComputerUsePageUrl } from "./computer-use-page-url";

const RENDERER_URL = "vm0-desktop://renderer/index.html";

describe("isDesktopComputerUsePageUrl", () => {
  it("allows the local Desktop renderer", () => {
    expect(isDesktopComputerUsePageUrl(RENDERER_URL, RENDERER_URL)).toBe(true);
  });

  it("rejects hosted Platform pages and other local files", () => {
    expect(
      isDesktopComputerUsePageUrl(
        "https://app.vm0.ai/computer-use",
        RENDERER_URL,
      ),
    ).toBe(false);
    expect(
      isDesktopComputerUsePageUrl(
        "vm0-desktop://renderer/other.html",
        RENDERER_URL,
      ),
    ).toBe(false);
    expect(isDesktopComputerUsePageUrl("not a url", RENDERER_URL)).toBe(false);
  });
});
