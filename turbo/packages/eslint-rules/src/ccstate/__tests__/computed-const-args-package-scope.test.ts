import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/computed-const-args-package-scope.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("computed-const-args-package-scope", rule, {
  valid: [
    // computed() at package scope — never a violation
    {
      code: `const x$ = computed(() => 'value');`,
    },
    // computed() at package scope with literal arg — allowed (package scope)
    {
      code: "const a$ = computed('theme');",
    },
    // command() at package scope — allowed
    {
      code: "const load$ = command(async () => {});",
    },
    // command() at package scope with get
    {
      code: `const cmd$ = command(({ get }) => get(x$));`,
    },
    // computed() with variable argument inside function — not constant, no violation
    {
      code: `function setup(key) { const x$ = computed(() => key); }`,
    },
    // command() with non-constant argument inside function — not flagged
    {
      code: "function setup(name) { const cmd$ = command(name); }",
    },
    // computed() inside function with zero arguments — not flagged (no literal args)
    {
      code: `function setup() { const x$ = computed(); }`,
    },
    // method calls are never flagged
    {
      code: `function setup() { const x$ = obj.computed('key'); }`,
    },
    // factory function called at package scope
    {
      code: `
        function makeSignal(key) { return computed(() => key); }
        const sig$ = makeSignal('theme');
      `,
    },
    // Package-scope helper returning computed called at package scope — allowed
    {
      code: "function localStorageSignal(key) { return computed(() => key); } const s$ = localStorageSignal('theme');",
    },
    // factory function called with variable argument (not constant)
    {
      code: `
        function makeSignal(key) { return computed(() => key); }
        function setup(key) { const sig$ = makeSignal(key); }
      `,
    },
    // Helper function returning Computed called inside function but with non-constant arg
    {
      code: "function localStorageSignal(key) { return computed(() => key); } function setup(k) { const s$ = localStorageSignal(k); }",
    },
    // factory function that returns plain value — not a signal factory
    {
      code: `
        function getLabel(key) { return key + '_label'; }
        function setup() { const label = getLabel('theme'); }
      `,
    },
    // non-$ object returned — not a signal factory
    {
      code: `
        function makeConfig(key) { return { value: key }; }
        function setup() { const cfg = makeConfig('theme'); }
      `,
    },
  ],
  invalid: [
    // computed() with string literal arg inside function
    {
      code: "function setup() { const theme$ = computed('dark'); }",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // computed() with string literal inside arrow function (wrapped)
    {
      code: `function setup() { const x$ = computed(() => 'value'); }`,
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // computed() with literal arg inside arrow function scope
    {
      code: "const init = () => { const s$ = computed('theme'); };",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // command() with literal arg inside function
    {
      code: "function setup() { const load$ = command('myCmd'); }",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // command() with string literal wrapped in arrow function inside function
    {
      code: `function setup() { const x$ = command(() => 'value'); }`,
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // factory function (direct return computed) called inside function with literal
    {
      code: `
        function makeSignal(key) { return computed(() => key); }
        function setup() { const sig$ = makeSignal('theme'); }
      `,
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // Package-scope helper function returning computed, called inside function with literal arg
    {
      code: "function localStorageSignal(key) { return computed(() => key); } function setup() { const s$ = localStorageSignal('theme'); }",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // factory function (object with $ keys) called inside function with literal
    {
      code: `
        function makeSignals(key) { return { value$: computed(() => key) }; }
        function setup() { const sigs = makeSignals('theme'); }
      `,
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // Package-scope helper with explicit Computed return type annotation
    {
      code: "function makeSignal(key: string): Computed<string> { return computed(() => key); } function setup() { const c$ = makeSignal('key'); }",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // computed with enum-like member expression (PascalCase.Member)
    {
      code: `function setup() { const x$ = computed(() => LocalStorageKey.Theme); }`,
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // computed() with enum-member argument inside a function
    {
      code: "function setup() { const theme$ = computed(LocalStorageKey.Theme); }",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // nested function scope (arrow function)
    {
      code: `
        const outer = () => {
          const x$ = computed(() => 'value');
        };
      `,
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // computed() with numeric literal inside nested function
    {
      code: "function outer() { function inner() { const n$ = computed(42); } }",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // computed with numeric literal (wrapped)
    {
      code: `function setup() { const x$ = computed(() => 42); }`,
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // computed with template literal (no expressions)
    {
      code: "function setup() { const x$ = computed(() => `value`); }",
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // computed with array of literals
    {
      code: `function setup() { const x$ = computed(() => ['a', 'b']); }`,
      errors: [{ messageId: "mustBePackageScope" }],
    },
  ],
});
