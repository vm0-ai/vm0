import { afterEach, describe, expect, it } from "vitest";
import { parseBodyBlocks } from "../parse-body-blocks.ts";

// Regression for https://vm0.sentry.io/issues/7662000470/ — Mobile Safari 16.6
// lacks URL.canParse, which used to throw a TypeError that crashed the whole
// chat message parse pipeline. tryParseUrl() now feature-detects URL.canParse
// and falls back to structural validation, so parsing must succeed (and stay
// behavior-identical) when URL.canParse is unavailable.

const ORIGINAL_CAN_PARSE = URL.canParse;

function withoutCanParse(): void {
  delete (URL as { canParse?: typeof URL.canParse }).canParse;
}

function restoreCanParse(): void {
  if (typeof URL.canParse !== "function" && ORIGINAL_CAN_PARSE) {
    Object.defineProperty(URL, "canParse", {
      value: ORIGINAL_CAN_PARSE,
      configurable: true,
      writable: true,
    });
  }
}

const SAMPLES: readonly string[] = [
  // Plain text message with no URLs.
  "just a normal message",
  // A normal web URL.
  "here is a link: https://example.com/hello",
  // A markdown image link.
  "![alt](https://example.com/image.png)",
  // A platform-file relative path (legacy artifact path).
  "/artifacts/run-1/file.png",
  // A platform file URL with an explicit https origin.
  "https://vm0.ai/artifacts/run-1/report.pdf",
];

describe("parseBodyBlocks with URL.canParse availability", () => {
  afterEach(() => {
    restoreCanParse();
  });

  it("produces identical output whether or not URL.canParse exists", () => {
    const withCanParse = SAMPLES.map((content) => {
      return parseBodyBlocks(content, { previews: true });
    });

    withoutCanParse();

    const without = SAMPLES.map((content) => {
      return parseBodyBlocks(content, { previews: true });
    });

    for (const index of SAMPLES.keys()) {
      const expected = withCanParse[index]!;
      const actual = without[index]!;
      expect(actual.cleanContent).toBe(expected.cleanContent);
      expect(actual.blocks).toStrictEqual(expected.blocks);
    }
  });

  it("does not throw when parsing without URL.canParse (old iOS Safari)", () => {
    withoutCanParse();
    expect(() => {
      for (const sample of SAMPLES) {
        parseBodyBlocks(sample, { previews: true });
      }
    }).not.toThrow();
  });
});
