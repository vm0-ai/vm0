import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noGetterSetterParams } from "../rules/no-getter-setter-params.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-getter-setter-params", noGetterSetterParams, {
  valid: [
    { code: "command(({ get, set }) => { })" },
    { code: "computed((get) => get(count$))" },
    { code: "function helper(value: string) { }" },
    { code: "const fn = (x: number) => x" },
    { code: "command(({ get }) => { function inner(get: Getter) { } })" },
    { code: "function helper(get) { }" },
    { code: "function helper(get: lib.Getter) { }" },
  ],
  invalid: [
    {
      code: "function helper(get: Getter) { }",
      errors: [{ messageId: "noGetterSetterParam" }],
    },
    {
      code: "function helper(set: Setter) { }",
      errors: [{ messageId: "noGetterSetterParam" }],
    },
    {
      code: "const fn = (get: Getter) => get(count$)",
      errors: [{ messageId: "noGetterSetterParam" }],
    },
    {
      code: "function helper(get: Getter, set: Setter) { }",
      errors: [
        { messageId: "noGetterSetterParam" },
        { messageId: "noGetterSetterParam" },
      ],
    },
  ],
});
