import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noFnDollarSuffix } from "../rules/no-fn-dollar-suffix.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-fn-dollar-suffix", noFnDollarSuffix, {
  valid: [
    { code: "const counter$ = state(0)" },
    { code: "const double$ = computed((get) => get(counter$) * 2)" },
    { code: "const reset$ = command(({ set }) => set(counter$, 0))" },
    { code: "function helper(arg) { return arg + 1 }" },
    { code: "const helper = (arg) => arg + 1" },
    { code: "function makeSignal() { return state(0) }" },
    { code: "const alias$ = otherSignal$" },
  ],
  invalid: [
    {
      code: "function fetchUser$(id) { return computed(() => null) }",
      errors: [{ messageId: "functionDeclaration" }],
    },
    {
      code: "const fetchUser$ = (id) => computed(() => null)",
      errors: [{ messageId: "arrowOrFunctionExpression" }],
    },
    {
      code: "const reset$ = () => 1",
      errors: [{ messageId: "arrowOrFunctionExpression" }],
    },
    {
      code: "const fn$ = function() { return 1 }",
      errors: [{ messageId: "arrowOrFunctionExpression" }],
    },
  ],
});
