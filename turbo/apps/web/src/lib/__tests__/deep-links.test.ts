import { describe, it, expect } from "vitest";
import { buildModelProviderLink, detectDeepLinks } from "../deep-links";

describe("buildModelProviderLink", () => {
  it("should return a deep link to the providers settings page", () => {
    const link = buildModelProviderLink("https://app.vm0.ai");

    expect(link).toEqual({
      emoji: "🔑",
      label: "Configure model providers",
      url: "https://app.vm0.ai/?settings=providers",
    });
  });
});

describe("detectDeepLinks", () => {
  const appUrl = "https://app.vm0.ai";

  it("should not detect model provider keywords", () => {
    const links = detectDeepLinks(
      "The model provider is not configured",
      appUrl,
    );
    expect(links).toEqual([]);
  });

  it("should still detect connector keywords", () => {
    const links = detectDeepLinks(
      "missing variable DATABASE_URL",
      appUrl,
      "my-agent",
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.label).toBe("Configure connectors");
  });
});
