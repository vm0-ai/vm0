import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/command-async-signal.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("command-async-signal", rule, {
  valid: [
    // sync command — no signal needed
    {
      code: "const load$ = command(({ get, set }) => { })",
    },
    // async command with only signal as user param
    {
      code: "command(async ({ get, set }, signal: AbortSignal) => { })",
    },
    // async command with extra user params, signal last
    {
      code: "command(async ({ get, set }, value: string, signal: AbortSignal) => { })",
    },
    // not a command call — no rule applies
    {
      code: "other(async ({ get, set }) => { })",
    },
  ],
  invalid: [
    // async command with no user params
    {
      code: "command(async ({ get, set }) => { })",
      errors: [{ messageId: "missingSignal" }],
    },
    // async command with user param but last is not AbortSignal
    {
      code: "command(async ({ get, set }, value: string) => { })",
      errors: [{ messageId: "signalNotLast" }],
    },
    // async command where signal is not last
    {
      code: "command(async ({ get, set }, signal: AbortSignal, extra: string) => { })",
      errors: [{ messageId: "signalNotLast" }],
    },
  ],
});
