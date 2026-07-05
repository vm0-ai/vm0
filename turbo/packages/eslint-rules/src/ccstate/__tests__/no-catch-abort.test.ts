import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-catch-abort.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-catch-abort", rule, {
  valid: [
    {
      code: `
        try {
          foo()
        } catch (e) {
          throwIfAbort(e)
        }
      `,
    },
    {
      code: `
        try {
          foo()
        } catch (e) {
          throwIfAbort(e)
          console.log(e)
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        try {
          foo()
        } catch {}
      `,
      errors: [{ messageId: "noCatchAbort" }],
    },
    {
      code: `
        try {
          foo()
        } catch (e) {
          throwIfAbort()
        }
      `,
      errors: [{ messageId: "noCatchAbort" }],
    },
    {
      code: `
        try {
          foo()
        } catch (e) {
          throwIfAbort(error)
        }
      `,
      errors: [{ messageId: "noCatchAbort" }],
    },
    {
      code: `
        try {
          foo()
        } catch (e) {
          console.log(e)
          throwIfAbort(e)
        }
      `,
      errors: [{ messageId: "noCatchAbort" }],
    },
  ],
});
