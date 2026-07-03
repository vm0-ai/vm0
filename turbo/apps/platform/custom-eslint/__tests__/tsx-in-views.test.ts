import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/tsx-in-views.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("tsx-in-views", rule, {
  valid: [
    {
      code: "const x = 1",
      filename: "/project/src/views/Dashboard.tsx",
    },
    {
      code: "export function Component() { return <div /> }",
      filename: "/project/src/views/nested/Page.tsx",
    },
    {
      code: "const store = state(0)",
      filename: "/project/src/stores/counter.ts",
    },
    {
      code: "export function Component() { return <div /> }",
      filename: "/project/src/__tests__/Component.test.tsx",
    },
  ],
  invalid: [
    {
      code: "const x = 1",
      filename: "/project/src/stores/counter.tsx",
      errors: [{ messageId: "tsxOutsideViews" }],
    },
    {
      code: "export function Component() { return <div /> }",
      filename: "/project/src/lib/utils.tsx",
      errors: [{ messageId: "tsxOutsideViews" }],
    },
  ],
});
