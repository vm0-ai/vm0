import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FIREWALL_HOSTNAME_POLICY_VERSION } from "../firewall-hostname-policy";
import {
  canonicalizeFirewallBaseUrl,
  validateBaseUrl,
} from "../firewall-types";

const baseUrlValidationCaseSchema = z.object({
  name: z.string(),
  category: z.string().optional(),
  note: z.string().optional(),
  base: z.string(),
  expectedValid: z.boolean(),
  expectedCanonicalBase: z.string().optional(),
});

const hostnamePolicyCaseSchema = z.object({
  name: z.string(),
  hostname: z.string(),
  expectedCanonicalHostname: z.string(),
});

const contractSchema = z
  .object({
    hostnamePolicy: z.literal(FIREWALL_HOSTNAME_POLICY_VERSION),
    hostnamePolicyCases: z.array(hostnamePolicyCaseSchema).min(1),
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

    const seenHostnamePolicyNames = new Set<string>();
    for (const [index, testCase] of contract.hostnamePolicyCases.entries()) {
      if (seenHostnamePolicyNames.has(testCase.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["hostnamePolicyCases", index, "name"],
          message: `duplicate case name "${testCase.name}"`,
        });
      }
      seenHostnamePolicyNames.add(testCase.name);
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
    if (testCase.expectedCanonicalBase !== undefined) {
      expect(canonicalizeFirewallBaseUrl(testCase.base, "contract")).toBe(
        testCase.expectedCanonicalBase,
      );
    }
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

describe("firewall hostname policy contract", () => {
  for (const testCase of contract.hostnamePolicyCases) {
    it(testCase.name, () => {
      expect(
        canonicalizeFirewallBaseUrl(`https://${testCase.hostname}`, "contract"),
      ).toBe(`https://${testCase.expectedCanonicalHostname}`);
    });
  }
});
