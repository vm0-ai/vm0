import { describe, expect, it } from "vitest";
import { CONNECTOR_TYPES } from "@vm0/core";
import { USE_CASES, buildTryItHref } from "../data";

describe("use cases data", () => {
  it("every connector id maps to a real CONNECTOR_TYPES key", () => {
    const invalid: string[] = [];
    for (const uc of USE_CASES) {
      for (const c of uc.connectors) {
        if (!(c.id in CONNECTOR_TYPES)) {
          invalid.push(`${uc.slug} → ${c.id}`);
        }
      }
    }
    expect(invalid).toEqual([]);
  });

  it("CTA prompt stays under the 200 char URL budget", () => {
    const overflow: string[] = [];
    for (const uc of USE_CASES) {
      const prompt = uc.ctaPrompt ?? uc.promptVariants[0]?.prompt ?? "";
      if (prompt.length > 200) {
        overflow.push(`${uc.slug} (${prompt.length})`);
      }
    }
    expect(overflow).toEqual([]);
  });
});

describe("buildTryItHref", () => {
  const sample = USE_CASES[0]!;

  it("encodes prompt and joins connector ids", () => {
    const href = buildTryItHref(sample, "https://app.example.com");
    const url = new URL(href);
    expect(url.origin).toBe("https://app.example.com");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("prompt")).toBe(
      sample.ctaPrompt ?? sample.promptVariants[0]?.prompt ?? "",
    );
    expect(url.searchParams.get("connector")).toBe(
      sample.connectors
        .map((c) => {
          return c.id;
        })
        .join(","),
    );
  });

  it("percent-encodes special characters in the prompt", () => {
    const uc: typeof sample = {
      ...sample,
      ctaPrompt: "hello world & friends",
    };
    const href = buildTryItHref(uc, "https://app.example.com");
    // URLSearchParams encodes space as `+` and `&` as `%26`.
    expect(href).toContain("prompt=hello+world+%26+friends");
  });

  it("omits empty params", () => {
    const uc: typeof sample = {
      ...sample,
      ctaPrompt: "",
      promptVariants: [],
      connectors: [],
    };
    expect(buildTryItHref(uc, "https://app.example.com")).toBe(
      "https://app.example.com",
    );
  });
});
