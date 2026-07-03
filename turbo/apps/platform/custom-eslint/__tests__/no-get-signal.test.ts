import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-get-signal.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-get-signal", rule, {
  valid: [
    // Non-AbortSignal state — allowed
    {
      code: "const count$ = state(0); command(({ get }) => { get(count$); })",
    },
    // AbortSignal passed as parameter — allowed
    {
      code: "command(async ({ get }, signal: AbortSignal) => { signal.throwIfAborted(); })",
    },
    // store.get() call — should not be flagged (different pattern)
    {
      code: "const signal$ = state<AbortSignal>(new AbortController().signal); command(({ get }) => { store.get(signal$); })",
    },
    // Computed with non-AbortSignal type arg — allowed
    {
      code: "const count$ = computed<number>(() => 0); command(({ get }) => { get(count$); })",
    },
    // NOTE: Signals imported from another file are NOT detected — this is an
    // intentional trade-off of the AST-only approach. Cross-file false negatives
    // are accepted for the performance gain.
    {
      code: "import { signal$ } from './other'; command(({ get }) => { get(signal$); })",
    },
  ],
  invalid: [
    // state<AbortSignal>(...) detected via type argument
    {
      code: "const signal$ = state<AbortSignal>(new AbortController().signal); command(({ get }) => { get(signal$); })",
      errors: [{ messageId: "noGetSignal" }],
    },
    // state initialized with new AbortController() — detected via initializer
    {
      code: "const ctrl$ = state(new AbortController()); command(({ get }) => { get(ctrl$); })",
      errors: [{ messageId: "noGetSignal" }],
    },
    // state initialized with new AbortController().signal — member expression
    {
      code: "const sig$ = state(new AbortController().signal); command(({ get }) => { get(sig$); })",
      errors: [{ messageId: "noGetSignal" }],
    },
    // computed<AbortSignal>(...) — also flagged
    {
      code: "const signal$ = computed<AbortSignal>(() => new AbortController().signal); command(({ get }) => { get(signal$); })",
      errors: [{ messageId: "noGetSignal" }],
    },
    // AbortSignal | undefined union type
    {
      code: "const signal$ = state<AbortSignal | undefined>(undefined); command(({ get }) => { get(signal$); })",
      errors: [{ messageId: "noGetSignal" }],
    },
    // AbortSignal | null union type
    {
      code: "const signal$ = state<AbortSignal | null>(null); command(({ get }) => { get(signal$); })",
      errors: [{ messageId: "noGetSignal" }],
    },
  ],
});
