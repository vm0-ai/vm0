import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-direct-fetch.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-direct-fetch", rule, {
  valid: [
    {
      // Allowed: using zeroClient$ instead
      code: `
        const client = get(zeroClient$)(someContract);
        await client.doSomething();
      `,
    },
    {
      // Allowed: defining fetch$ itself
      code: `export const fetch$ = atom(() => fetch);`,
    },
    {
      // Allowed: importing fetch$ (file-level exemptions handle allowed usages)
      code: `import { fetch$ } from "./fetch";`,
    },
    {
      // Allowed: unrelated identifiers
      code: `const result = get(otherSignal$);`,
    },
  ],
  invalid: [
    {
      code: `const fetchFn = get(fetch$);`,
      errors: [{ messageId: "noDirectFetch" }],
    },
    {
      code: `const result = await get(fetch$)("/api/zero/something", { method: "POST" });`,
      errors: [{ messageId: "noDirectFetch" }],
    },
    {
      code: `use(fetch$);`,
      errors: [{ messageId: "noDirectFetch" }],
    },
    {
      code: `
        function doRequest() {
          return get(fetch$)("/api/endpoint");
        }
      `,
      errors: [{ messageId: "noDirectFetch" }],
    },
  ],
});
