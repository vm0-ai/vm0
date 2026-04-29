import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noStoreInParams } from "../rules/no-store-in-params.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-store-in-params", noStoreInParams, {
  valid: [
    { code: "function helper(value: string) { }" },
    {
      code: "function setupRouter(store: Store) { }",
      options: [{ allowedFunctions: ["setupRouter"] }],
    },
    {
      code: "const setupRouter = (store: Store) => { }",
      options: [{ allowedFunctions: ["setupRouter"] }],
    },
    { code: "function init() { }" },
    { code: "function init(store: lib.Store) { }" },
    { code: "type TestStore = Store; function init(store: TestStore) { }" },
    { code: "function init(store) { }" },
  ],
  invalid: [
    {
      code: "function helper(store: Store) { }",
      errors: [{ messageId: "noStoreInParams" }],
    },
    {
      code: "const helper = (store: Store) => { }",
      errors: [{ messageId: "noStoreInParams" }],
    },
    {
      code: "function helper(options: { store: Store }) { }",
      errors: [{ messageId: "noStoreInObjectParams" }],
    },
    {
      code: "function helper(stores: Array<Store>) { }",
      errors: [{ messageId: "noStoreInParams" }],
    },
    {
      code: "class Helper { cleanup(store: Store) { } }",
      errors: [{ messageId: "noStoreInParams" }],
    },
  ],
});
