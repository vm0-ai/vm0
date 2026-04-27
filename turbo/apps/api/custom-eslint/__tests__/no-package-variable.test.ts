import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noPackageVariable } from "../rules/no-package-variable.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-package-variable", noPackageVariable, {
  valid: [
    { code: "const MAX = 42;" },
    { code: "const NAME = 'hello';" },
    { code: "const count$ = state(0);" },
    { code: "const doubled$ = computed((get) => get(count$) * 2);" },
    { code: "const load$ = command(async () => {});" },
    { code: "const config = Object.freeze({ key: 'value' });" },
    { code: "const items: Readonly<Record<string, number>> = {};" },
    { code: "const list: readonly string[] = [];" },
    { code: "function init() { let x = 0; }" },
    { code: "function init() { const cache = new Map(); }" },
    { code: "const { a, b } = getConfig();" },
    { code: "const [first, second] = getItems();" },
    {
      code: "const registry = new LoggerRegistry();",
      options: [{ allowedConstructors: ["LoggerRegistry"] }],
    },
    {
      code: "const tracker = new PromiseTracker();",
      options: [{ allowedConstructors: ["PromiseTracker", "LoggerRegistry"] }],
    },
  ],
  invalid: [
    {
      code: "let counter = 0;",
      errors: [{ messageId: "noPackageVariable" }],
    },
    {
      code: "var counter = 0;",
      errors: [{ messageId: "noPackageVariable" }],
    },
    {
      code: "const items = [];",
      errors: [{ messageId: "noPackageVariable" }],
    },
    {
      code: "const cache = {};",
      errors: [{ messageId: "noPackageVariable" }],
    },
    {
      code: "const cache = new Map();",
      errors: [{ messageId: "noPackageVariable" }],
    },
    {
      code: "const set = new Set();",
      errors: [{ messageId: "noPackageVariable" }],
    },
    {
      code: "const inst = new lib.Registry();",
      errors: [{ messageId: "noPackageVariable" }],
    },
    {
      code: "const cache = new Map();",
      options: [{ allowedConstructors: ["LoggerRegistry"] }],
      errors: [{ messageId: "noPackageVariable" }],
    },
  ],
});
