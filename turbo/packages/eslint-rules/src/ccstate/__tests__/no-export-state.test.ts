import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-export-state.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-export-state", rule, {
  valid: [
    {
      code: "const count$ = state(0)",
    },
    {
      code: "export const getCount = () => count$",
    },
    {
      code: "export const doubled$ = computed((get) => get(count$) * 2)",
    },
    {
      code: "export const fetchData$ = command(async () => {})",
    },
    {
      code: "export function useCount() { return count$ }",
    },
    {
      code: "interface InternalSignals { state$: State<Foo> }",
    },
    {
      code: "export interface PublicSignals { value$: Computed<Foo>; setValue$: Command<void, [Foo]> }",
    },
  ],
  invalid: [
    {
      code: "export const count$ = state(0)",
      errors: [{ messageId: "noExportState" }],
    },
    {
      code: "export const items$ = state([])",
      errors: [{ messageId: "noExportState" }],
    },
    {
      code: "export interface PublicSignals { state$: State<Foo> }",
      errors: [{ messageId: "noExportStateType" }],
    },
    {
      code: "export type PublicSignals = { state$: State<Foo> }",
      errors: [{ messageId: "noExportStateType" }],
    },
    {
      code: "export type PublicSignals = { nested: { state$: State<Foo> } }",
      errors: [{ messageId: "noExportStateType" }],
    },
  ],
});
