import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import rule from "../rules/no-test-after-each.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-test-after-each", rule, {
  valid: [
    {
      code: `context.signal.addEventListener("abort", cleanup, { once: true });`,
    },
    {
      code: `context.track(subscription);`,
    },
  ],
  invalid: [
    {
      code: `afterEach(cleanup);`,
      errors: [{ messageId: "noTestAfterEach" }],
    },
    {
      code: `
        import { afterEach as cleanupAfterTest } from "vitest";
        cleanupAfterTest(cleanup);
      `,
      errors: [{ messageId: "noTestAfterEach" }],
    },
  ],
});
