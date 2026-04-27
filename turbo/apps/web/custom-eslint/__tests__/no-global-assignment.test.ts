import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-global-assignment.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const ALLOWED_INIT_SERVICES = "/abs/src/lib/init-services.ts";
const ALLOWED_GLOBAL_DTS = "/abs/src/types/global.d.ts";
const REGULAR_FILE = "/abs/src/lib/some-feature.ts";

ruleTester.run("no-global-assignment", rule, {
  valid: [
    // Reads of the sanctioned singleton are fine
    {
      code: "const db = globalThis.services.db;",
      filename: REGULAR_FILE,
    },
    {
      code: "globalThis.services.db.select();",
      filename: REGULAR_FILE,
    },
    // Deep-chain mutation is a mutation of a property on `services`, not on
    // the global itself. Out of scope for this rule.
    {
      code: "globalThis.services.cache = new Map();",
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
    // Allowlisted files can install globals freely
    {
      code: "Object.defineProperty(globalThis, 'services', { get: () => s });",
      filename: ALLOWED_INIT_SERVICES,
    },
    {
      code: "globalThis.anything = 1;",
      filename: ALLOWED_INIT_SERVICES,
    },
    {
      code: "declare global { var services: Services; }",
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
      // Services re-declaration outside the allowlisted files is still banned
      code: "declare global { var services: Services; }",
      filename: REGULAR_FILE,
      errors: [{ messageId: "noDeclareGlobal" }],
    },
  ],
});
