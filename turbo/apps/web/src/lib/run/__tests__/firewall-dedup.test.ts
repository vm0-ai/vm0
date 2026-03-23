import { describe, it, expect } from "vitest";
import { baseUrlCoveredBy, deduplicateAutoFirewalls } from "../build-context";

describe("baseUrlCoveredBy", () => {
  it("returns true for exact match", () => {
    expect(
      baseUrlCoveredBy("https://api.github.com", "https://api.github.com"),
    ).toBe(true);
  });

  it("returns true when compose is a prefix at path boundary", () => {
    expect(
      baseUrlCoveredBy(
        "https://www.googleapis.com/drive",
        "https://www.googleapis.com",
      ),
    ).toBe(true);
  });

  it("returns true when compose has trailing slash", () => {
    expect(
      baseUrlCoveredBy(
        "https://api.github.com/repos",
        "https://api.github.com/",
      ),
    ).toBe(true);
  });

  it("returns true when compose has trailing slash and auto does not", () => {
    expect(
      baseUrlCoveredBy("https://api.github.com", "https://api.github.com/"),
    ).toBe(true);
  });

  it("returns true when both have trailing slashes", () => {
    expect(
      baseUrlCoveredBy("https://api.github.com/", "https://api.github.com/"),
    ).toBe(true);
  });

  it("returns false when auto is a prefix of compose", () => {
    expect(
      baseUrlCoveredBy(
        "https://www.googleapis.com",
        "https://www.googleapis.com/drive",
      ),
    ).toBe(false);
  });

  it("returns false for partial segment match", () => {
    expect(
      baseUrlCoveredBy(
        "https://api.github.com-evil.com",
        "https://api.github.com",
      ),
    ).toBe(false);
  });

  it("returns false for completely different URLs", () => {
    expect(
      baseUrlCoveredBy("https://api.anthropic.com", "https://slack.com/api"),
    ).toBe(false);
  });
});

describe("deduplicateAutoFirewalls", () => {
  const mkFw = (name: string, bases: string[]) => ({
    name,
    apis: bases.map((base) => ({ base })),
  });

  it("returns all auto firewalls when no compose firewalls", () => {
    const auto = [
      mkFw("model-provider:anthropic", ["https://api.anthropic.com"]),
    ];
    expect(deduplicateAutoFirewalls(auto, [])).toEqual(auto);
  });

  it("drops auto firewall when compose covers same base URL", () => {
    const auto = [
      mkFw("model-provider:anthropic", ["https://api.anthropic.com"]),
    ];
    const compose = [mkFw("custom", ["https://api.anthropic.com"])];
    expect(deduplicateAutoFirewalls(auto, compose)).toEqual([]);
  });

  it("drops auto firewall when compose covers base URL via prefix", () => {
    const auto = [mkFw("auto:drive", ["https://www.googleapis.com/drive"])];
    const compose = [mkFw("google", ["https://www.googleapis.com"])];
    expect(deduplicateAutoFirewalls(auto, compose)).toEqual([]);
  });

  it("drops entire auto firewall when any base URL overlaps", () => {
    const auto = [
      mkFw("connector:github", [
        "https://api.github.com",
        "https://uploads.github.com",
      ]),
    ];
    const compose = [mkFw("custom", ["https://api.github.com"])];
    expect(deduplicateAutoFirewalls(auto, compose)).toEqual([]);
  });

  it("drops entire auto firewall when all base URLs overlap", () => {
    const auto = [
      mkFw("connector:github", [
        "https://api.github.com",
        "https://uploads.github.com",
      ]),
    ];
    const compose = [
      mkFw("gh-api", ["https://api.github.com"]),
      mkFw("gh-uploads", ["https://uploads.github.com"]),
    ];
    expect(deduplicateAutoFirewalls(auto, compose)).toEqual([]);
  });

  it("keeps unrelated auto firewalls", () => {
    const auto = [
      mkFw("model-provider:anthropic", ["https://api.anthropic.com"]),
      mkFw("connector:slack", ["https://slack.com/api"]),
    ];
    const compose = [mkFw("custom", ["https://api.anthropic.com"])];
    expect(deduplicateAutoFirewalls(auto, compose)).toEqual([
      mkFw("connector:slack", ["https://slack.com/api"]),
    ]);
  });
});
