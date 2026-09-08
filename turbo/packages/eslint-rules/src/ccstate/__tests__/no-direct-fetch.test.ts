import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-direct-fetch.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-direct-fetch", rule, {
  valid: [
    { code: `await fetchResource(url, {}, signal);` },
    { code: `await client.fetch();` },
    { code: `function run(fetch) { return fetch(); }` },
    { code: `function run(window) { return window.fetch(); }` },
    {
      // Allowed: using apiClient$ instead
      code: `
        const client = get(apiClient$)(someContract);
        await client.doSomething();
      `,
    },
    {
      // Allowed: unrelated identifiers
      code: `const result = get(otherSignal$);`,
    },
  ],
  invalid: [
    {
      code: `await fetch("/api/data");`,
      errors: [{ messageId: "noNativeFetch" }],
    },
    { code: `const send = fetch;`, errors: [{ messageId: "noNativeFetch" }] },
    {
      code: `await globalThis.fetch("/api/data");`,
      errors: [{ messageId: "noNativeFetch" }],
    },
    {
      code: `await window["fetch"]("/api/data");`,
      errors: [{ messageId: "noNativeFetch" }],
    },
    {
      code: `const send = self.fetch;`,
      errors: [{ messageId: "noNativeFetch" }],
    },
  ],
});
