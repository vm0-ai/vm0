import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-request-json-as.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-request-json-as", rule, {
  valid: [
    {
      // safeParse pattern — no type assertion
      code: "const result = schema.safeParse(await request.json());",
    },
    {
      // Type assertion on response.json() — not request
      code: "const data = (await response.json()) as SomeType;",
    },
    {
      // No type assertion
      code: "const body = await request.json();",
    },
    {
      // Different method on request
      code: "const text = (await request.text()) as string;",
    },
  ],
  invalid: [
    {
      code: "const body = (await request.json()) as { email: string };",
      errors: [{ messageId: "noRequestJsonAs" }],
    },
    {
      code: "const body = (await request.json()) as SomeInterface;",
      errors: [{ messageId: "noRequestJsonAs" }],
    },
  ],
});
