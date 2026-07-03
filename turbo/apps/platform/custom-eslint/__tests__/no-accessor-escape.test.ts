import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-accessor-escape.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-accessor-escape", rule, {
  valid: [
    {
      code: "command(({ get, set }) => { const value = get(count$); set(total$, value); })",
    },
    {
      code: "command(({ set }) => { set(count$, (prev) => prev + 1); })",
    },
    {
      code: "computed((get) => pages.map((page$) => get(page$)))",
    },
    {
      code: "command(({ get: read, set: write }) => { read(count$); write(total$, 1); })",
    },
    {
      code: "command(({ set }) => { command(({ set }) => { set(child$, 1); }); set(parent$, 1); })",
    },
    {
      code: "function helper(get) { return get; }",
    },
  ],
  invalid: [
    {
      code: "command(({ get }) => { helper(pages, get); })",
      errors: [{ messageId: "accessorEscape" }],
    },
    {
      code: "command(({ set }) => { helper({ set }); })",
      errors: [{ messageId: "accessorEscape" }],
    },
    {
      code: "command(({ set }) => { helper({ setFlow: set }); })",
      errors: [{ messageId: "accessorEscape" }],
    },
    {
      code: "command(({ get }) => { const read = get; return read(count$); })",
      errors: [{ messageId: "accessorEscape" }],
    },
    {
      code: "command(({ get }) => { return get; })",
      errors: [{ messageId: "accessorEscape" }],
    },
    {
      code: "command(({ get }) => { return () => get(count$); })",
      errors: [{ messageId: "accessorEscape" }],
    },
    {
      code: "command(({ get }) => { return { read: () => get(count$) }; })",
      errors: [{ messageId: "accessorEscape" }],
    },
    {
      code: "command(({ get }) => { setTimeout(() => get(count$), 0); })",
      errors: [{ messageId: "accessorEscape" }],
    },
    {
      code: "command(({ set }) => { const values = [set]; return values; })",
      errors: [{ messageId: "accessorEscape" }],
    },
    {
      code: "computed((get) => helper(get))",
      errors: [{ messageId: "accessorEscape" }],
    },
    {
      code: "command(({ get: read }) => { helper(read); })",
      errors: [{ messageId: "accessorEscape" }],
    },
  ],
});
