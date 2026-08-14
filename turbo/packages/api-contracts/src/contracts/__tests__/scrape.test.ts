import { describe, expect, it } from "vitest";

import { scrapeResponseSchema } from "../scrape";

const baseResponse = {
  requestedUrl: "https://example.com/page",
  mode: "standard",
  provider: "firecrawl",
  creditsCharged: 4,
  billingCategory: "standard.markdown",
  billingQuantity: 1,
} as const;

describe("scrapeResponseSchema", () => {
  it("requires markdown result for markdown responses", () => {
    expect(
      scrapeResponseSchema.safeParse({
        ...baseResponse,
        format: "markdown",
        result: { markdown: "# Example" },
      }).success,
    ).toBe(true);

    expect(
      scrapeResponseSchema.safeParse({
        ...baseResponse,
        format: "markdown",
        result: {},
      }).success,
    ).toBe(false);
  });

  it("requires links result for links responses", () => {
    expect(
      scrapeResponseSchema.safeParse({
        ...baseResponse,
        format: "links",
        billingCategory: "standard.links",
        result: { links: ["https://example.com/a"] },
      }).success,
    ).toBe(true);

    expect(
      scrapeResponseSchema.safeParse({
        ...baseResponse,
        format: "links",
        billingCategory: "standard.links",
        result: {},
      }).success,
    ).toBe(false);
  });

  it("rejects unknown billing categories", () => {
    expect(
      scrapeResponseSchema.safeParse({
        ...baseResponse,
        format: "markdown",
        billingCategory: "unknown",
        result: { markdown: "# Example" },
      }).success,
    ).toBe(false);
  });

  it("rejects billing categories that do not match format and mode", () => {
    expect(
      scrapeResponseSchema.safeParse({
        ...baseResponse,
        format: "markdown",
        billingCategory: "standard.links",
        result: { markdown: "# Example" },
      }).success,
    ).toBe(false);
  });

  it("requires response URL fields to be URLs", () => {
    expect(
      scrapeResponseSchema.safeParse({
        ...baseResponse,
        requestedUrl: "not a url",
        format: "markdown",
        result: { markdown: "# Example" },
      }).success,
    ).toBe(false);

    expect(
      scrapeResponseSchema.safeParse({
        ...baseResponse,
        finalUrl: "/relative",
        format: "markdown",
        result: { markdown: "# Example" },
      }).success,
    ).toBe(false);
  });
});
