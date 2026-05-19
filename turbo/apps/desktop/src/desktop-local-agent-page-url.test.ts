import { describe, expect, it } from "vitest";
import { isDesktopLocalAgentPageUrl } from "./desktop-local-agent-page-url";

const ALLOWED_ORIGINS = new Set([
  "https://app.vm0.ai",
  "http://localhost:3000",
]);

describe("isDesktopLocalAgentPageUrl", () => {
  it("allows the desktop local agent page from configured app origins", () => {
    expect(
      isDesktopLocalAgentPageUrl(
        "https://app.vm0.ai/local-agents",
        ALLOWED_ORIGINS,
      ),
    ).toBe(true);
    expect(
      isDesktopLocalAgentPageUrl(
        "http://localhost:3000/local-agents/",
        ALLOWED_ORIGINS,
      ),
    ).toBe(true);
  });

  it("rejects other pages and origins", () => {
    expect(
      isDesktopLocalAgentPageUrl(
        "https://app.vm0.ai/connectors",
        ALLOWED_ORIGINS,
      ),
    ).toBe(false);
    expect(
      isDesktopLocalAgentPageUrl(
        "https://evil.example/local-agents",
        ALLOWED_ORIGINS,
      ),
    ).toBe(false);
    expect(isDesktopLocalAgentPageUrl("not a url", ALLOWED_ORIGINS)).toBe(
      false,
    );
  });
});
