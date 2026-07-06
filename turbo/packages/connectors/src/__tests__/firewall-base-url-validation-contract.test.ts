import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { validateBaseUrl } from "../firewall-types";

const baseUrlValidationCaseSchema = z.object({
  name: z.string(),
  category: z.string().optional(),
  note: z.string().optional(),
  base: z.string(),
  expectedValid: z.boolean(),
});

const contractSchema = z
  .object({
    baseUrlValidationCases: z.array(baseUrlValidationCaseSchema).min(1),
  })
  .superRefine((contract, ctx) => {
    const seenNames = new Set<string>();
    for (const [index, testCase] of contract.baseUrlValidationCases.entries()) {
      if (seenNames.has(testCase.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["baseUrlValidationCases", index, "name"],
          message: `duplicate case name "${testCase.name}"`,
        });
      }
      seenNames.add(testCase.name);
    }
  });

type BaseUrlValidationCase = z.infer<typeof baseUrlValidationCaseSchema>;

function loadContract(): z.infer<typeof contractSchema> {
  const rawContract: unknown = JSON.parse(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "firewall-base-url-validation-contract.json",
      ),
      "utf-8",
    ),
  );
  return contractSchema.parse(rawContract);
}

function assertValidationResult(testCase: BaseUrlValidationCase): void {
  const validate = (): void => {
    validateBaseUrl(testCase.base, "contract");
  };

  if (testCase.expectedValid) {
    expect(validate).not.toThrow();
    return;
  }

  expect(validate).toThrow();
}

const contract = loadContract();

describe("firewall base URL validation contract", () => {
  for (const testCase of contract.baseUrlValidationCases) {
    it(testCase.name, () => {
      assertValidationResult(testCase);
    });
  }
});
