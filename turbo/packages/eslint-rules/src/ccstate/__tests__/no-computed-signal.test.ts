import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import rule from "../rules/no-computed-signal.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-computed-signal", rule, {
  valid: [
    {
      code: "const value$ = computed((get) => get(source$));",
    },
    {
      code: "const value$ = computed(async (get) => await get(source$));",
    },
    {
      code: "const value$ = library.computed((get, options) => options.signal);",
    },
    {
      code: "const run$ = command(async ({ get }, signal: AbortSignal) => get(source$));",
    },
  ],
  invalid: [
    {
      code: "const value$ = computed((get, { signal }) => load(signal));",
      errors: [{ messageId: "noComputedSignal" }],
    },
    {
      code: "const value$ = computed(async (get, { signal: requestSignal }) => load(requestSignal));",
      errors: [{ messageId: "noComputedSignal" }],
    },
    {
      code: "const value$ = computed((get, options) => load(options.signal));",
      errors: [{ messageId: "noComputedSignal" }],
    },
    {
      code: "const value$ = computed(function (get, { signal }) { return load(signal); });",
      errors: [{ messageId: "noComputedSignal" }],
    },
  ],
});
