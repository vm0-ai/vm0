import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-manual-mock-cleanup.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-manual-mock-cleanup", rule, {
  valid: [
    {
      code: `vi.fn();`,
    },
    {
      code: `vi.spyOn(window, "matchMedia");`,
    },
    {
      code: `mock.restoreAllMocks();`,
    },
  ],
  invalid: [
    {
      code: `vi.restoreAllMocks();`,
      errors: [{ messageId: "noManualMockCleanup" }],
    },
    {
      code: `vi.clearAllMocks();`,
      errors: [{ messageId: "noManualMockCleanup" }],
    },
    {
      code: `vi.unstubAllGlobals();`,
      errors: [{ messageId: "noManualMockCleanup" }],
    },
    {
      code: `afterEach(() => { vi.restoreAllMocks(); });`,
      errors: [{ messageId: "noManualMockCleanup" }],
    },
  ],
});
