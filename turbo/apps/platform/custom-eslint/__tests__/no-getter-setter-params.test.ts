import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-getter-setter-params.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-getter-setter-params", rule, {
  valid: [
    // Inside command callback — allowed
    {
      code: "command(({ get, set }) => { })",
    },
    // Inside computed callback — allowed
    {
      code: "computed((get) => get(count$))",
    },
    // Regular function with non-ccstate params
    {
      code: "function helper(value: string) { }",
    },
    // Arrow function with no Getter/Setter params
    {
      code: "const fn = (x: number) => x",
    },
    // Getter/Setter inside nested command callback
    {
      code: "command(({ get, set }) => { function inner(get: Getter) {} })",
    },
    // No type annotation — untyped params are not flagged
    {
      code: "function helper(get) { }",
    },
    // Qualified type name — only bare Getter/Setter is matched
    {
      code: "function helper(get: lib.Getter) { }",
    },
  ],
  invalid: [
    // Function declaration with Getter param
    {
      code: "function helper(get: Getter) { }",
      errors: [{ messageId: "noGetterSetterParam" }],
    },
    // Function declaration with Setter param
    {
      code: "function helper(set: Setter) { }",
      errors: [{ messageId: "noGetterSetterParam" }],
    },
    // Arrow function with Getter param
    {
      code: "const fn = (get: Getter) => get(count$)",
      errors: [{ messageId: "noGetterSetterParam" }],
    },
    // Multiple Getter/Setter params
    {
      code: "function helper(get: Getter, set: Setter) { }",
      errors: [
        { messageId: "noGetterSetterParam" },
        { messageId: "noGetterSetterParam" },
      ],
    },
  ],
});
