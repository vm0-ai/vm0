import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noGetterSetterParams } from "../rules/no-getter-setter-params.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-getter-setter-params", noGetterSetterParams, {
  valid: [
    { code: "command(({ get, set }) => { })" },
    { code: "computed((get) => get(count$))" },
    { code: "function helper(value: string) { }" },
    { code: "const fn = (x: number) => x" },
    { code: "command(({ get }) => { function inner(get: Getter) { } })" },
    { code: "function helper(get) { }" },
    { code: "function helper(get: lib.Getter) { }" },
    // Non-Getter/Setter object-type members must not be flagged.
    { code: "function helper(args: { readonly value: string }) { }" },
    // A plain alias unrelated to ccstate must not be flagged.
    { code: "type Id = string;" },
  ],
  invalid: [
    {
      code: "function helper(get: Getter) { }",
      errors: [{ messageId: "noGetterSetterParam" }],
    },
    {
      code: "function helper(set: Setter) { }",
      errors: [{ messageId: "noGetterSetterParam" }],
    },
    {
      code: "const fn = (get: Getter) => get(count$)",
      errors: [{ messageId: "noGetterSetterParam" }],
    },
    {
      code: "function helper(get: Getter, set: Setter) { }",
      errors: [
        { messageId: "noGetterSetterParam" },
        { messageId: "noGetterSetterParam" },
      ],
    },
    // (a) Aliased positional param: the alias declaration is banned at the
    // root, killing the evasion vector even though the param uses the alias.
    {
      code: "type ComputedGetter = Getter; function helper(get: ComputedGetter) { }",
      errors: [{ messageId: "noGetterSetterAlias" }],
    },
    // (b) Object-field typed via an alias: alias declaration is banned.
    {
      code: "type ComputedGetter = Getter; function helper(args: { get: ComputedGetter }) { }",
      errors: [{ messageId: "noGetterSetterAlias" }],
    },
    // (c) Real Setter sitting inside an options-bag object type literal.
    {
      code: "function helper(args: { readonly stateSet: Setter }) { }",
      errors: [{ messageId: "noGetterSetterParam" }],
    },
    // Object literal with both Getter and Setter members reports each.
    {
      code: "function helper(args: { readonly get: Getter; readonly set: Setter }) { }",
      errors: [
        { messageId: "noGetterSetterParam" },
        { messageId: "noGetterSetterParam" },
      ],
    },
    // Nested object literal: recurse into inner members.
    {
      code: "function helper(args: { nested: { get: Getter } }) { }",
      errors: [{ messageId: "noGetterSetterParam" }],
    },
    // (d) Banned `type X = Getter` declaration on its own.
    {
      code: "type X = Getter;",
      errors: [{ messageId: "noGetterSetterAlias" }],
    },
    // Union/intersection alias containing Getter/Setter is banned.
    {
      code: "type MaybeGetter = Getter | undefined;",
      errors: [{ messageId: "noGetterSetterAlias" }],
    },
  ],
});
