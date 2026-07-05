import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noNewPromise } from "../rules/no-new-promise.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-new-promise", noNewPromise, {
  valid: [
    {
      code: `
        const deferred = createDeferredPromise(signal);
        await deferred.promise;
      `,
    },
    {
      code: `
        await delay(100, { signal });
      `,
    },
  ],
  invalid: [
    {
      code: `
        const pending = new Promise((resolve) => {
          resolve(1);
        });
      `,
      errors: [{ messageId: "noNewPromise" }],
    },
  ],
});
