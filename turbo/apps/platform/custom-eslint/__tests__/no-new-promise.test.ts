import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-new-promise.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-new-promise", rule, {
  valid: [
    {
      code: `
        const deferred = createDeferredPromise(signal);
        await deferred.promise;
      `,
    },
    {
      code: `
        await never();
      `,
    },
  ],
  invalid: [
    {
      code: `
        const p = new Promise((resolve) => {
          resolve(1);
        });
      `,
      errors: [{ messageId: "noNewPromise" }],
    },
  ],
});
