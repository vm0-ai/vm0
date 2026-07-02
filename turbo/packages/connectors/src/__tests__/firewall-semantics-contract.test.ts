import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

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
});

type SegmentExpected = z.infer<typeof segmentExpectedSchema>;

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
});
