import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/signal-dollar-suffix.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("signal-dollar-suffix", rule, {
  valid: [
    {
      code: "const count$ = state(0)",
    },
    {
      code: "const items$ = state([])",
    },
    {
      code: "const doubled$ = computed((get) => get(count$) * 2)",
    },
    {
      code: "const fetch$ = command(async () => {})",
    },
    {
      code: "const normalVar = 'hello'",
    },
    {
      code: "const result = someOtherFunction()",
    },
  ],
  invalid: [
    {
      code: "const count = state(0)",
      errors: [{ messageId: "missingSuffix" }],
      output: "const count$ = state(0)",
    },
    {
      code: "const items = state([])",
      errors: [{ messageId: "missingSuffix" }],
      output: "const items$ = state([])",
    },
    {
      code: "const doubled = computed((get) => get(count$) * 2)",
      errors: [{ messageId: "missingSuffix" }],
      output: "const doubled$ = computed((get) => get(count$) * 2)",
    },
    {
      code: "const fetchData = command(async () => {})",
      errors: [{ messageId: "missingSuffix" }],
      output: "const fetchData$ = command(async () => {})",
    },
  ],
});
