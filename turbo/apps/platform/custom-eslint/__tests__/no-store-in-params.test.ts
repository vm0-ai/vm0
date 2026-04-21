import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-store-in-params.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-store-in-params", rule, {
  valid: [
    // No Store param
    {
      code: "function doWork(value: string) { }",
    },
    // Allowed function name via option
    {
      code: "function setupRouter(store: Store) { }",
      options: [{ allowedFunctions: ["setupRouter"] }],
    },
    // Arrow with allowed name
    {
      code: "const setupRouter = (store: Store) => { }",
      options: [{ allowedFunctions: ["setupRouter"] }],
    },
    // No params at all
    {
      code: "function init() { }",
    },
    // Qualified Store type — only bare Store is matched (TSQualifiedName is ignored)
    {
      code: "function init(s: lib.Store) { }",
    },
    // Type alias for Store is not detected — only explicit Store annotations are matched
    {
      code: "type MyStore = Store; function init(s: MyStore) { }",
    },
    // Untyped param is not flagged
    {
      code: "function init(s) { }",
    },
  ],
  invalid: [
    // Direct Store param
    {
      code: "function processStore(store: Store) { }",
      errors: [{ messageId: "noStoreInParams" }],
    },
    // Arrow function with Store param
    {
      code: "const fn = (store: Store) => { }",
      errors: [{ messageId: "noStoreInParams" }],
    },
    // Store nested in object type
    {
      code: "function init(opts: { store: Store }) { }",
      errors: [{ messageId: "noStoreInObjectParams" }],
    },
    // Store in array generic
    {
      code: "function init(stores: Array<Store>) { }",
      errors: [{ messageId: "noStoreInParams" }],
    },
    // Method with Store param
    {
      code: "class Foo { bar(store: Store) { } }",
      errors: [{ messageId: "noStoreInParams" }],
    },
  ],
});
