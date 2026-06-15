import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-empty-promise-catch.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-empty-promise-catch", rule, {
  valid: [
    // detach() is the correct pattern
    {
      code: `detach(loadFile(file, signal), Reason.DomCallback);`,
    },
    // .catch with actual error handling is fine
    {
      code: `fetchData().catch((e) => { console.error(e); });`,
    },
    // .catch with a named function is fine
    {
      code: `fetchData().catch(handleError);`,
    },
    // .then().catch() with non-empty catch is fine
    {
      code: `fetchData().then(process).catch((e) => { showToast(e.message); });`,
    },
    // await is fine
    {
      code: `await fetchData();`,
    },
    // .catch with return statement is fine
    {
      code: `fetchData().catch(() => { return fallback; });`,
    },
  ],
  invalid: [
    // Arrow function with empty block
    {
      code: `loadFile(file, signal).catch(() => {});`,
      errors: [{ messageId: "noEmptyPromiseCatch" }],
    },
    // Function expression with empty block
    {
      code: `loadFile(file, signal).catch(function() {});`,
      errors: [{ messageId: "noEmptyPromiseCatch" }],
    },
    // Chained .then().catch(() => {})
    {
      code: `fetchData().then(process).catch(() => {});`,
      errors: [{ messageId: "noEmptyPromiseCatch" }],
    },
    // In event handler context
    {
      code: `handleToggle(entry, enabled).catch(() => {});`,
      errors: [{ messageId: "noEmptyPromiseCatch" }],
    },
  ],
});
