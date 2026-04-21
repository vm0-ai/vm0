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
    // computed() with variable argument — not constant, no violation
    {
      code: `function setup(key) { const x$ = computed(() => key); }`,
    },
    // command() at package scope
    {
      code: `const cmd$ = command(({ get }) => get(x$));`,
    },
    // factory function called at package scope
    {
      code: `
        function makeSignal(key) { return computed(() => key); }
        const sig$ = makeSignal('theme');
      `,
    },
    // factory function called with variable argument (not constant)
    {
      code: `
        function makeSignal(key) { return computed(() => key); }
        function setup(key) { const sig$ = makeSignal(key); }
      `,
    },
    // computed with zero arguments — not flagged
    {
      code: `function setup() { const x$ = computed(); }`,
    },
    // method calls are never flagged
    {
      code: `function setup() { const x$ = obj.computed('key'); }`,
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
    // computed() with string literal inside function
    {
      code: `function setup() { const x$ = computed(() => 'value'); }`,
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // command() with string literal inside function
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
    // factory function (object with $ keys) called inside function with literal
    {
      code: `
        function makeSignals(key) { return { value$: computed(() => key) }; }
        function setup() { const sigs = makeSignals('theme'); }
      `,
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // computed with enum-like member expression (PascalCase.Member)
    {
      code: `function setup() { const x$ = computed(() => LocalStorageKey.Theme); }`,
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // nested function scope
    {
      code: `
        const outer = () => {
          const x$ = computed(() => 'value');
        };
      `,
      errors: [{ messageId: "mustBePackageScope" }],
    },
    // computed with numeric literal
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
