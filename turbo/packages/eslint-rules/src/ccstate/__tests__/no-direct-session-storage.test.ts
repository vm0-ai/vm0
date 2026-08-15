import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import rule from "../rules/no-direct-session-storage.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-direct-session-storage", rule, {
  valid: [
    {
      code: `
        import { sessionStorageSignals } from "../external/session-storage";
        const { get$, set$ } = sessionStorageSignals("active-org");
      `,
    },
    {
      code: `const storage = new Map();`,
    },
    {
      code: `localStorage.getItem("key");`,
    },
  ],
  invalid: [
    {
      code: `sessionStorage.getItem("active-org");`,
      errors: [{ messageId: "noDirectSessionStorage" }],
    },
    {
      code: `sessionStorage.setItem("active-org", "org_1");`,
      errors: [{ messageId: "noDirectSessionStorage" }],
    },
    {
      code: `sessionStorage.removeItem("active-org");`,
      errors: [{ messageId: "noDirectSessionStorage" }],
    },
    {
      code: `sessionStorage.clear();`,
      errors: [{ messageId: "noDirectSessionStorage" }],
    },
    {
      code: `window.sessionStorage.getItem("active-org");`,
      errors: [{ messageId: "noDirectSessionStorage" }],
    },
    {
      code: `globalThis.sessionStorage.setItem("active-org", "org_1");`,
      errors: [{ messageId: "noDirectSessionStorage" }],
    },
  ],
});
