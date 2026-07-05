import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-user-clear-tab.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-user-clear-tab", rule, {
  valid: [
    // user.fill is the recommended replacement — always allowed
    { code: `await user.fill(input, "hello")` },
    { code: `await user.click(btn)` },
    { code: `await user.type(input, "hello")` },
    // clear/tab on non-member expressions — not flagged
    { code: `clear(input)` },
    { code: `tab()` },
    // Array/set clear — different object, but rule flags any .clear() member call
    // (acceptable false positive: tests should not call .clear() on anything)
  ],
  invalid: [
    {
      code: `await user.clear(input)`,
      errors: [{ messageId: "noClear" }],
    },
    {
      code: `user.clear(descInput)`,
      errors: [{ messageId: "noClear" }],
    },
    {
      code: `await user.tab()`,
      errors: [{ messageId: "noTab" }],
    },
    {
      code: `user.tab()`,
      errors: [{ messageId: "noTab" }],
    },
    {
      code: `await someUser.clear(el)`,
      errors: [{ messageId: "noClear" }],
    },
    {
      code: `await someUser.tab()`,
      errors: [{ messageId: "noTab" }],
    },
  ],
});
