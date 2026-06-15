import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-test-delay.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-test-delay", rule, {
  valid: [
    // Importing non-delay from msw is fine
    {
      code: `import { http, HttpResponse } from "msw";`,
    },
    // Importing non-delay from signal-timers is fine
    {
      code: `import { timeout } from "signal-timers";`,
    },
    // createDeferredPromise is the recommended pattern
    {
      code: `import { createDeferredPromise } from "../../signals/utils.ts";`,
    },
    // vi.waitFor is fine
    {
      code: `await vi.waitFor(() => { expect(x).toBe(1); });`,
    },
    // vi.advanceTimersByTimeAsync is fine (fake timers)
    {
      code: `await vi.advanceTimersByTimeAsync(3000);`,
    },
    // window.setTimeout as member expression is not flagged
    {
      code: `window.setTimeout(() => {}, 100);`,
    },
  ],
  invalid: [
    // delay from signal-timers
    {
      code: `import { delay } from "signal-timers";`,
      errors: [{ messageId: "noDelayImport" }],
    },
    // delay from msw
    {
      code: `import { delay } from "msw";`,
      errors: [{ messageId: "noDelayImport" }],
    },
    // delay among other msw imports
    {
      code: `import { http, HttpResponse, delay } from "msw";`,
      errors: [{ messageId: "noDelayImport" }],
    },
    // setTimeout
    {
      code: `setTimeout(() => {}, 100);`,
      errors: [{ messageId: "noSetTimeout" }],
    },
    // setInterval
    {
      code: `setInterval(() => {}, 1000);`,
      errors: [{ messageId: "noSetInterval" }],
    },
  ],
});
