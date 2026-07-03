import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noCatchAbort } from "../rules/no-catch-abort.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-catch-abort", noCatchAbort, {
  valid: [
    {
      code: `
        try {
          foo()
        } catch (error) {
          throwIfAbort(error)
        }
      `,
    },
    {
      code: `
        try {
          foo()
        } catch (error) {
          throwIfAbort(error)
          console.log(error)
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
        } catch (error) {
          throwIfAbort()
        }
      `,
      errors: [{ messageId: "noCatchAbort" }],
    },
    {
      code: `
        try {
          foo()
        } catch (error) {
          console.log(error)
          throwIfAbort(error)
        }
      `,
      errors: [{ messageId: "noCatchAbort" }],
    },
  ],
});
