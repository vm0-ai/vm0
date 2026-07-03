import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  matchFirewallBaseUrl,
  matchFirewallHost,
  matchFirewallPath,
  matchFirewallPathPrefix,
} from "../firewall-rule-matcher";
import { parseSegment, splitPathSegments } from "../segment-parser";

const segmentExpectedSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("literal"),
    value: z.string(),
  }),
  z.object({
    kind: z.literal("param"),
    prefix: z.string(),
    name: z.string(),
    suffix: z.string(),
    greedy: z.union([z.literal(""), z.literal("+"), z.literal("*")]),
  }),
  z.object({
    kind: z.literal("error"),
    reasonIncludes: z.string(),
  }),
]);

const paramsMatchExpectedSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("match"),
    params: z.record(z.string(), z.string()),
  }),
  z.object({
    kind: z.literal("no-match"),
  }),
]);

const relativePathMatchExpectedSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("match"),
    relativePath: z.string(),
  }),
  z.object({
    kind: z.literal("no-match"),
  }),
]);

const contractSchema = z.object({
  segmentParseCases: z.array(
    z.object({
      name: z.string(),
      segment: z.string(),
      expected: segmentExpectedSchema,
    }),
  ),
  pathSplitCases: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      expected: z.array(z.string()),
    }),
  ),
  pathMatchCases: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      pattern: z.string(),
      expected: paramsMatchExpectedSchema,
    }),
  ),
  hostMatchCases: z.array(
    z.object({
      name: z.string(),
      host: z.string(),
      pattern: z.string(),
      expected: paramsMatchExpectedSchema,
    }),
  ),
  pathPrefixMatchCases: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      pattern: z.string(),
      expected: relativePathMatchExpectedSchema,
    }),
  ),
  baseUrlMatchCases: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      base: z.string(),
      expected: relativePathMatchExpectedSchema,
    }),
  ),
});

type SegmentExpected = z.infer<typeof segmentExpectedSchema>;
type ParamsMatchExpected = z.infer<typeof paramsMatchExpectedSchema>;
type RelativePathMatchExpected = z.infer<
  typeof relativePathMatchExpectedSchema
>;

function loadContract(): z.infer<typeof contractSchema> {
  const rawContract: unknown = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "firewall-semantics-contract.json"),
      "utf-8",
    ),
  );
  return contractSchema.parse(rawContract);
}

function assertSegmentResult(segment: string, expected: SegmentExpected): void {
  const actual = parseSegment(segment);
  if (expected.kind === "error") {
    if (actual.kind !== "error") {
      throw new Error(
        `Expected segment "${segment}" to fail parsing, got ${JSON.stringify(actual)}`,
      );
    }
    expect(actual.reason).toContain(expected.reasonIncludes);
    return;
  }

  expect(actual).toEqual(expected);
}

function assertParamsMatch(
  actual: Record<string, string> | null,
  expected: ParamsMatchExpected,
): void {
  if (expected.kind === "no-match") {
    expect(actual).toBeNull();
    return;
  }

  expect(actual).toEqual(expected.params);
}

function assertRelativePathMatch(
  actual: string | null,
  expected: RelativePathMatchExpected,
): void {
  if (expected.kind === "no-match") {
    expect(actual).toBeNull();
    return;
  }

  expect(actual).toBe(expected.relativePath);
}

const contract = loadContract();

describe("firewall semantics contract", () => {
  describe("segment parsing", () => {
    for (const testCase of contract.segmentParseCases) {
      it(testCase.name, () => {
        assertSegmentResult(testCase.segment, testCase.expected);
      });
    }
  });

  describe("path splitting", () => {
    for (const testCase of contract.pathSplitCases) {
      it(testCase.name, () => {
        expect(splitPathSegments(testCase.path)).toEqual(testCase.expected);
      });
    }
  });

  describe("path matching", () => {
    for (const testCase of contract.pathMatchCases) {
      it(testCase.name, () => {
        assertParamsMatch(
          matchFirewallPath(testCase.path, testCase.pattern),
          testCase.expected,
        );
      });
    }
  });

  describe("host matching", () => {
    for (const testCase of contract.hostMatchCases) {
      it(testCase.name, () => {
        assertParamsMatch(
          matchFirewallHost(testCase.host, testCase.pattern),
          testCase.expected,
        );
      });
    }
  });

  describe("path prefix matching", () => {
    for (const testCase of contract.pathPrefixMatchCases) {
      it(testCase.name, () => {
        assertRelativePathMatch(
          matchFirewallPathPrefix(testCase.path, testCase.pattern),
          testCase.expected,
        );
      });
    }
  });

  describe("base URL matching", () => {
    for (const testCase of contract.baseUrlMatchCases) {
      it(testCase.name, () => {
        assertRelativePathMatch(
          matchFirewallBaseUrl(testCase.url, testCase.base)?.relativePath ??
            null,
          testCase.expected,
        );
      });
    }
  });
});
