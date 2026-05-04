import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-direct-local-storage.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-direct-local-storage", rule, {
  valid: [
    {
      code: `
        import { localStorageSignals } from "../external/local-storage";
        const { get$, set$ } = localStorageSignals("theme");
      `,
    },
    {
      code: `const storage = new Map();`,
    },
    {
      code: `sessionStorage.getItem("key");`,
    },
  ],
  invalid: [
    {
      code: `localStorage.getItem("theme");`,
      errors: [{ messageId: "noDirectLocalStorage" }],
    },
    {
      code: `localStorage.setItem("theme", "dark");`,
      errors: [{ messageId: "noDirectLocalStorage" }],
    },
    {
      code: `localStorage.removeItem("theme");`,
      errors: [{ messageId: "noDirectLocalStorage" }],
    },
    {
      code: `const v = localStorage.getItem("key") ?? "default";`,
      errors: [{ messageId: "noDirectLocalStorage" }],
    },
    {
      code: `window.localStorage.getItem("theme");`,
      errors: [{ messageId: "noDirectLocalStorage" }],
    },
    {
      code: `window.localStorage.setItem("theme", "dark");`,
      errors: [{ messageId: "noDirectLocalStorage" }],
    },
  ],
});
