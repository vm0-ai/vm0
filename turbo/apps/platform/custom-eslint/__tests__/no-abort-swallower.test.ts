import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-abort-swallower.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-abort-swallower", rule, {
  valid: [
    // detach() is the correct pattern
    {
      code: `detach(set(cmd$, signal), Reason.DomCallback);`,
    },
    // .catch with a genuine handler is fine
    {
      code: `fetchData().catch((e) => { console.error(e); });`,
    },
    // .catch with a non-swallower named handler is fine
    {
      code: `fetchData().catch(handleApiError);`,
    },
    // .then with only success handler is fine
    {
      code: `fetchData().then(process);`,
    },
    // .then with real success + real rejection handlers is fine
    {
      code: `fetchData().then(process, (e) => { showToast(e.message); });`,
    },
    // .then with real success + named real handler is fine
    {
      code: `fetchData().then(process, handleApiError);`,
    },
    // await propagates abort naturally
    {
      code: `async function run() { await set(cmd$, signal); }`,
    },
    // throwIfNotAbort used directly in a catch block is fine (not as a handler)
    {
      code: `async function run() { try { await doWork(); } catch (e) { throwIfNotAbort(e); } }`,
    },
  ],
  invalid: [
    // .catch(throwIfNotAbort) — the main pattern
    {
      code: `set(cmd$, signal).catch(throwIfNotAbort);`,
      errors: [{ messageId: "noAbortSwallower" }],
    },
    // .catch(throwIfNotAbort) inside a chain
    {
      code: `fetchData().then(process).catch(throwIfNotAbort);`,
      errors: [{ messageId: "noAbortSwallower" }],
    },
    // .then(_, throwIfNotAbort) — the .then second-arg variant
    {
      code: `fetchData().then(process, throwIfNotAbort);`,
      errors: [{ messageId: "noAbortSwallower" }],
    },
    // .then(_, () => {}) — empty rejection handler; swallows input rejection
    {
      code: `fetchExtra(id).then((x) => { use(x); }, () => {});`,
      errors: [{ messageId: "noEmptyThenReject" }],
    },
    {
      code: `fetchExtra(id).then(process, function () {});`,
      errors: [{ messageId: "noEmptyThenReject" }],
    },
  ],
});
