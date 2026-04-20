import { describe, expect, it } from "vitest";
import { CONNECTOR_TYPES } from "@vm0/core";
import { USE_CASES, buildPromptHref } from "../../app/[locale]/use-cases/data";

describe("use cases data", () => {
  it("every connector id maps to a real CONNECTOR_TYPES key", () => {
    // "vm0" is used for marketing display only and is not a platform connector
    const KNOWN_DISPLAY_ONLY = new Set(["vm0"]);
    const invalid: string[] = [];
    for (const uc of USE_CASES) {
      for (const c of uc.connectors) {
        if (!(c.id in CONNECTOR_TYPES) && !KNOWN_DISPLAY_ONLY.has(c.id)) {
          invalid.push(`${uc.slug} → ${c.id}`);
        }
      }
    }
    expect(invalid).toEqual([]);
  });
});

describe("buildPromptHref", () => {
  const connectors = USE_CASES[0]!.connectors;

  it("strips @Zero prefix from the prompt", () => {
    const href = buildPromptHref(
      "@Zero top 3 Sentry errors in the last 24h",
      connectors,
      "https://app.example.com",
    );
    const url = new URL(href);
    expect(url.searchParams.get("prompt")).toBe(
      "top 3 Sentry errors in the last 24h",
    );
  });

  it("passes through prompts without @Zero prefix unchanged", () => {
    const href = buildPromptHref(
      "show me recent errors",
      connectors,
      "https://app.example.com",
    );
    const url = new URL(href);
    expect(url.searchParams.get("prompt")).toBe("show me recent errors");
  });

  it("percent-encodes special characters", () => {
    const href = buildPromptHref(
      "hello world & friends",
      connectors,
      "https://app.example.com",
    );
    expect(href).toContain("prompt=hello+world+%26+friends");
  });

  it("omits empty params", () => {
    expect(buildPromptHref("", [], "https://app.example.com")).toBe(
      "https://app.example.com",
    );
  });
});
