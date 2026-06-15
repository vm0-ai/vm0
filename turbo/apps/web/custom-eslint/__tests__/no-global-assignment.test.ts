import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-global-assignment.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const ALLOWED_GLOBAL_DTS = "/abs/src/types/global.d.ts";
const REGULAR_FILE = "/abs/src/lib/some-feature.ts";

ruleTester.run("no-global-assignment", rule, {
  valid: [
    // Deep-chain mutation is a mutation of a property on `cache`, not on the
    // global itself. Out of scope for this rule.
    {
      code: "globalThis.cache.value = 1;",
      filename: REGULAR_FILE,
    },
    // DOM writes are untouched — the rule only covers globalThis/global
    {
      code: "window.location.href = '/';",
      filename: REGULAR_FILE,
    },
    {
      code: "Object.defineProperty(window, 'matchMedia', { value: fn });",
      filename: REGULAR_FILE,
    },
    {
      code: "self.foo = 1;",
      filename: REGULAR_FILE,
    },
    // Ambient declarations live in the dedicated global type file
    {
      code: "declare global { interface Window { readonly bridge?: Bridge; } }",
      filename: ALLOWED_GLOBAL_DTS,
    },
    // Assignments to local objects (not a global root) are untouched
    {
      code: "const x = { services: 1 }; x.services = 2;",
      filename: REGULAR_FILE,
    },
  ],
  invalid: [
    {
      code: "globalThis.foo = 1;",
      filename: REGULAR_FILE,
      errors: [{ messageId: "noGlobalAssignment" }],
    },
    {
      code: "globalThis['foo'] = 1;",
      filename: REGULAR_FILE,
      errors: [{ messageId: "noGlobalAssignment" }],
    },
    {
      code: "global.foo = 1;",
      filename: REGULAR_FILE,
      errors: [{ messageId: "noGlobalAssignment" }],
    },
    {
      code: "(globalThis as any).foo = 1;",
      filename: REGULAR_FILE,
      errors: [{ messageId: "noGlobalAssignment" }],
    },
    {
      code: "Object.defineProperty(globalThis, 'foo', { value: 1 });",
      filename: REGULAR_FILE,
      errors: [{ messageId: "noGlobalDefineProperty" }],
    },
    {
      code: "Reflect.defineProperty(globalThis, 'foo', { value: 1 });",
      filename: REGULAR_FILE,
      errors: [{ messageId: "noGlobalDefineProperty" }],
    },
    {
      code: "Object.defineProperty(global, 'foo', { value: 1 });",
      filename: REGULAR_FILE,
      errors: [{ messageId: "noGlobalDefineProperty" }],
    },
    {
      code: "Object.assign(globalThis, { foo: 1 });",
      filename: REGULAR_FILE,
      errors: [{ messageId: "noGlobalAssign" }],
    },
    {
      code: "declare global { var foo: number; }",
      filename: REGULAR_FILE,
      errors: [{ messageId: "noDeclareGlobal" }],
    },
    {
      code: "declare global { interface Window { readonly bridge?: Bridge; } }",
      filename: REGULAR_FILE,
      errors: [{ messageId: "noDeclareGlobal" }],
    },
  ],
});
