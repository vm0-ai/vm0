import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { extractFirewallTemplateReferences } from "../firewall-types";

const templateReferenceSchema = z.object({
  namespace: z.enum(["secrets", "vars"]),
  name: z.string(),
  source: z.string().min(1),
});
const templateReferencesSchema = z.object({
  secrets: z.array(z.string()),
  vars: z.array(z.string()),
});
const simpleReferenceCaseSchema = z.object({
  name: z.string(),
  template: z.string(),
  expectedReferences: z.array(templateReferenceSchema),
});
const basicTemplateCaseSchema = z.object({
  name: z.string(),
  template: z.string(),
  expectedTemplateReferences: templateReferencesSchema,
  expectedDiagnosticNames: z.array(z.string()),
});
const contractSchema = z
  .object({
    simpleReferenceCases: z.array(simpleReferenceCaseSchema).min(1),
    basicTemplateCases: z.array(basicTemplateCaseSchema).min(1),
  })
  .superRefine((contract, ctx) => {
    const seenNames = new Set<string>();
    const cases = [
      ...contract.simpleReferenceCases,
      ...contract.basicTemplateCases,
    ];
    for (const [index, testCase] of cases.entries()) {
      if (seenNames.has(testCase.name)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `duplicate case name "${testCase.name}"`,
        });
      }
      seenNames.add(testCase.name);
    }
  });

type SimpleReferenceCase = z.infer<typeof simpleReferenceCaseSchema>;

function loadContract(): z.infer<typeof contractSchema> {
  const rawContract: unknown = JSON.parse(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "firewall-template-reference-contract.json",
      ),
      "utf-8",
    ),
  );
  return contractSchema.parse(rawContract);
}

function extractReferences(template: string): {
  readonly secrets: readonly string[];
  readonly vars: readonly string[];
} {
  return extractFirewallTemplateReferences([
    {
      base: "https://contract.example.com",
      auth: { headers: { Authorization: template } },
    },
  ]);
}

function expectedSimpleReferences(testCase: SimpleReferenceCase): {
  readonly secrets: readonly string[];
  readonly vars: readonly string[];
} {
  const secrets = new Set<string>();
  const vars = new Set<string>();
  for (const reference of testCase.expectedReferences) {
    const names = reference.namespace === "secrets" ? secrets : vars;
    names.add(reference.name);
  }
  return { secrets: [...secrets], vars: [...vars] };
}

const contract = loadContract();

describe("firewall template reference contract", () => {
  for (const testCase of contract.simpleReferenceCases) {
    it(testCase.name, () => {
      expect(extractReferences(testCase.template)).toStrictEqual(
        expectedSimpleReferences(testCase),
      );
    });
  }

  for (const testCase of contract.basicTemplateCases) {
    it(testCase.name, () => {
      expect(extractReferences(testCase.template)).toStrictEqual(
        testCase.expectedTemplateReferences,
      );
    });
  }
});
