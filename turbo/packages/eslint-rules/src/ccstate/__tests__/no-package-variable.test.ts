import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-package-variable.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-package-variable", rule, {
  valid: [
    // Primitive const — not mutable
    {
      code: "const MAX = 42;",
    },
    // String literal const — allowed
    {
      code: "const NAME = 'hello';",
    },
    // ccstate signal — allowed (not new/array/object)
    {
      code: "const count$ = state(0);",
    },
    // ccstate computed — allowed
    {
      code: "const doubled$ = computed((get) => get(count$) * 2);",
    },
    // ccstate command — allowed
    {
      code: "const load$ = command(async () => {});",
    },
    // Object.freeze — not flagged (not a new expression, array, or plain object)
    {
      code: "const config = Object.freeze({ key: 'value' });",
    },
    // Readonly type annotation — explicitly readonly, skipped
    {
      code: "const items: Readonly<Record<string, number>> = {};",
    },
    // readonly array type annotation — skipped
    {
      code: "const list: readonly string[] = [];",
    },
    // let inside a function — not package scope
    {
      code: "function init() { let x = 0; }",
    },
    // new Map() inside a function — not package scope
    {
      code: "function init() { const cache = new Map(); }",
    },
    // A keyed collection is allowed when its factory is only used by a bounded owner.
    {
      code: "function createOwner() { const resources = new Map(); return { resources }; } function setup() { const owner = createOwner(); return owner; }",
    },
    // Non-cache test flags on globalThis remain available to tests.
    {
      code: 'Reflect.set(globalThis, "loadPreviewInTest", true);',
    },
    // Readonly lookup data can be built once at package scope.
    {
      code: "const isAllowed = (() => { const allowed: ReadonlySet<string> = new Set(['a']); return (key: string) => allowed.has(key); })();",
    },
    // Destructuring pattern at package scope — skipped
    {
      code: "const { a, b } = getConfig();",
    },
    // Array destructuring at package scope — skipped
    {
      code: "const [first, second] = getItems();",
    },
    // allowedConstructors option — explicitly allowed constructor
    {
      code: "const registry = new LoggerRegistry();",
      options: [{ allowedConstructors: ["LoggerRegistry"] }],
    },
    // allowedConstructors — multiple entries
    {
      code: "const tracker = new PromiseTracker();",
      options: [{ allowedConstructors: ["PromiseTracker", "LoggerRegistry"] }],
    },
  ],
  invalid: [
    // let at package scope — always mutable
    {
      code: "let counter = 0;",
      errors: [{ messageId: "noPackageVariable" }],
    },
    // var at package scope
    {
      code: "var counter = 0;",
      errors: [{ messageId: "noPackageVariable" }],
    },
    // const array at package scope — mutable array reference
    {
      code: "const items = [];",
      errors: [{ messageId: "noPackageVariable" }],
    },
    // const object literal at package scope
    {
      code: "const cache = {};",
      errors: [{ messageId: "noPackageVariable" }],
    },
    // new Map() at package scope — mutable constructor
    {
      code: "const cache = new Map();",
      errors: [{ messageId: "noPackageVariable" }],
    },
    // new Set() at package scope — mutable constructor
    {
      code: "const set = new Set();",
      errors: [{ messageId: "noPackageVariable" }],
    },
    // new with complex callee expression (not a simple Identifier)
    {
      code: "const inst = new lib.Registry();",
      errors: [{ messageId: "noPackageVariable" }],
    },
    // allowedConstructors does not apply to a different constructor
    {
      code: "const cache = new Map();",
      options: [{ allowedConstructors: ["LoggerRegistry"] }],
      errors: [{ messageId: "noPackageVariable" }],
    },
    // A factory closure can hide a package-lifetime keyed cache.
    {
      code: "function createResourceFactory() { const resources = new Map(); return (key) => resources.get(key); } const getResource = createResourceFactory();",
      errors: [{ messageId: "noPackageFactoryCache" }],
    },
    // The same pattern can be hidden in a package-scope IIFE.
    {
      code: "const getResource = (() => { const resources = new Map(); return (key) => resources.get(key); })();",
      errors: [{ messageId: "noPackageFactoryCache" }],
    },
    {
      code: 'Reflect.set(globalThis, "okouPreviewCache", new Map());',
      errors: [{ messageId: "noGlobalCache" }],
    },
    {
      code: "function getResource() {} getResource._cache = new Map();",
      errors: [{ messageId: "noFunctionPropertyCache" }],
    },
    {
      code: 'function getResource() {} getResource["_cache"] = new Map();',
      errors: [{ messageId: "noFunctionPropertyCache" }],
    },
  ],
});
