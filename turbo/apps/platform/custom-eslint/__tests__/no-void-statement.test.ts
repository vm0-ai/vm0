import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-void-statement.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-void-statement", rule, {
  valid: [
    // detach() is the correct fire-and-forget pattern from DOM callbacks
    {
      code: `detach(updateParams(next), Reason.DomCallback);`,
    },
    // await inside async context is fine
    {
      code: `async function run() { await updateParams(next); }`,
    },
    // void in an expression (not a statement) is fine — e.g. as an arrow
    // body `() => void foo()`; the result is used, not discarded as a statement
    {
      code: `const fn = () => void runAnalytics();`,
    },
    // void 0 / void "str" — traditional undefined pattern, not a call
    {
      code: `void 0;`,
    },
    {
      code: `void "compile-time-assert";`,
    },
    // Promise.all with a fire-and-forget loop — this is the docs-blessed
    // pattern for signals that need to run daemons alongside their own work
    {
      code: `async function run(signal) { await Promise.all([set(loop$, signal), doWork()]); }`,
    },
  ],
  invalid: [
    // Statement-level void on a plain call
    {
      code: `void updateParams(next);`,
      errors: [{ messageId: "noVoidStatement" }],
    },
    // void on a chained .catch — the pattern we are specifically trying
    // to outlaw (floating promise disguised by a silencer)
    {
      code: `void set(startSkeletonCycling$, signal).catch(throwIfNotAbort);`,
      errors: [{ messageId: "noVoidStatement" }],
    },
    // void on a chained .then with an empty rejection handler
    {
      code: `void fetchExtra(id, sig).then((x) => { use(x); }, () => {});`,
      errors: [{ messageId: "noVoidStatement" }],
    },
    // void on an optional chain call
    {
      code: `void foo?.bar();`,
      errors: [{ messageId: "noVoidStatement" }],
    },
    // void on a new-expression
    {
      code: `void new SomeClass();`,
      errors: [{ messageId: "noVoidStatement" }],
    },
    // void on an await expression (should be plain await instead)
    {
      code: `async function run() { void await doWork(); }`,
      errors: [{ messageId: "noVoidStatement" }],
    },
  ],
});
