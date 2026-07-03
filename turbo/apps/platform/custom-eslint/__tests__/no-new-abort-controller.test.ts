import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-new-abort-controller.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-new-abort-controller", rule, {
  valid: [
    {
      code: `const signal = pageSignal$;`,
    },
    {
      code: `const signal = useGet(pageSignal$);`,
    },
    {
      code: `const ac = new SomeOtherClass();`,
    },
  ],
  invalid: [
    {
      code: `const controller = new AbortController();`,
      errors: [{ messageId: "noNewAbortController" }],
    },
    {
      code: `const signal = new AbortController().signal;`,
      errors: [{ messageId: "noNewAbortController" }],
    },
  ],
});
