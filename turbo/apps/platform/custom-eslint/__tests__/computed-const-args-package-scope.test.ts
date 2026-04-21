import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/computed-const-args-package-scope.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("computed-const-args-package-scope", rule, {
  valid: [
    // computed() at package scope — allowed
    {
      code: "const theme$ = computed(() => 'dark');",
    },
    // command() at package scope — allowed
    {
      code: "const load$ = command(async () => {});",
    },
    // computed() inside function but with non-constant argument — not flagged
    {
      code: "function setup(key) { const val$ = computed(() => key); }",
    },
    // computed() at package scope with literal arg — allowed (package scope)
    {
      code: "const a$ = computed('theme');",
    },
    // Helper function returning Computed called inside function but with non-constant arg
    {
      code: "function localStorageSignal(key) { return computed(() => key); } function setup(k) { const s$ = localStorageSignal(k); }",
    },
    // Package-scope helper returning computed called at package scope — allowed
    {
      code: "function localStorageSignal(key) { return computed(() => key); } const s$ = localStorageSignal('theme');",
    },
    // computed() inside function with zero arguments — not flagged (no literal args)
    {
      code: "function setup() { const val$ = computed(); }",
    },
    // Method call inside function — not a ccstate factory
    {
      code: "function setup() { const val$ = obj.computed('theme'); }",
    },
    // command() with non-constant argument inside function — not flagged
    {
      code: "function setup(name) { const cmd$ = command(name); }",
    },
  ],
  invalid: [
    // computed() with literal arg inside a function — must be at package scope
    {
      code: "function setup() { const theme$ = computed('dark'); }",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // command() with literal arg inside a function — must be at package scope
    {
      code: "function setup() { const load$ = command('myCmd'); }",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // computed() with literal arg inside arrow function
    {
      code: "const init = () => { const s$ = computed('theme'); };",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // Package-scope helper function returning computed, called inside function with literal arg
    {
      code: "function localStorageSignal(key) { return computed(() => key); } function setup() { const s$ = localStorageSignal('theme'); }",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // computed() with numeric literal inside nested function
    {
      code: "function outer() { function inner() { const n$ = computed(42); } }",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // Package-scope helper with explicit Computed return type annotation
    {
      code: "function makeSignal(key: string): Computed<string> { return computed(() => key); } function setup() { const c$ = makeSignal('key'); }",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // computed() with enum-member argument inside a function — must be at package scope
    {
      code: "function setup() { const theme$ = computed(LocalStorageKey.Theme); }",
      errors: [{ messageId: "mustBePackageScope" }],
    },
  ],
});
