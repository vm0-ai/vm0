import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/test-context-in-hooks.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("test-context-in-hooks", rule, {
  valid: [
    {
      name: "testContext called at top level without destructuring",
      code: `
        const context = testContext()
      `,
    },
    {
      name: "testContext destructured in it",
      code: `
        it('should work', () => {
          const { store, signal } = testContext()
        })
      `,
    },
    {
      name: "testContext destructured in test",
      code: `
        test('should work', () => {
          const { store, signal } = testContext()
        })
      `,
    },
    {
      name: "testContext destructured in beforeEach",
      code: `
        beforeEach(() => {
          const { store, signal } = testContext()
        })
      `,
    },
    {
      name: "testContext destructured in afterEach",
      code: `
        afterEach(() => {
          const { store } = testContext()
        })
      `,
    },
  ],
  invalid: [
    {
      name: "testContext destructured at top level",
      code: `
        const { store, signal } = testContext()
      `,
      errors: [{ messageId: "testContextDestructuringOutsideHook" }],
    },
    {
      name: "testContext destructured in describe but not in hook",
      code: `
        describe('test suite', () => {
          const { store, signal } = testContext()
        })
      `,
      errors: [{ messageId: "testContextDestructuringOutsideHook" }],
    },
  ],
});
