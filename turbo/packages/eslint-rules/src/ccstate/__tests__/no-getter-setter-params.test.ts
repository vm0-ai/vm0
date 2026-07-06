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
    // No type annotation — untyped params are not flagged
    {
      code: "function helper(get) { }",
    },
    // Qualified type name — only bare Getter/Setter is matched
    {
      code: "function helper(get: lib.Getter) { }",
    },
    // Type alias for Getter is not detected — only explicit Getter/Setter annotations are matched
    {
      code: "type MyGetter = Getter; function helper(get: MyGetter) { }",
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
    // Getter/Setter inside nested command callback is still a helper boundary
    {
      code: "command(({ get, set }) => { function inner(get: Getter) {} })",
      errors: [{ messageId: "noGetterSetterParam" }],
    },
    // Object property with Setter
    {
      code: "function helper(args: { set: Setter; value: string }) { }",
      errors: [{ messageId: "noGetterSetterObjectParam" }],
    },
    // Destructured object property with Getter
    {
      code: "function helper({ get }: { get: Getter }) { }",
      errors: [{ messageId: "noGetterSetterObjectParam" }],
    },
    // Getter in generic args
    {
      code: "function helper(getters: Array<Getter>) { }",
      errors: [{ messageId: "noGetterSetterParam" }],
    },
  ],
});
