import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import rule from "../rules/no-manual-polling.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-manual-polling", rule, {
  valid: [
    { code: "while (hasNext) { await readNextPage(); }" },
    { code: "while (!signal.aborted) { await nextEvent.promise; }" },
    { code: "await setLoop(check, 1000, signal);" },
    { code: "await delay(1000, { signal });" },
    {
      code: "for (const item of items) { item.onClick(async () => { await delay(100); }); }",
    },
  ],
  invalid: [
    {
      code: "while (!done) { await Promise.all([refresh(), delay(100)]); }",
      errors: [{ messageId: "manualPolling" }],
    },
    {
      code: "while (!done) { await refresh(); await delay(1000); }",
      errors: [{ messageId: "manualPolling" }],
    },
    {
      code: "do { await sleep(100); } while (!done);",
      errors: [{ messageId: "manualPolling" }],
    },
    {
      code: "for (;;) { await timers.delay(100); }",
      errors: [{ messageId: "manualPolling" }],
    },
    {
      code: "import { delay as pause } from 'signal-timers'; while (!done) { await pause(100); }",
      errors: [{ messageId: "manualPolling" }],
    },
    {
      code: "import { setTimeout as pause } from 'node:timers/promises'; while (!done) { await pause(100); }",
      errors: [{ messageId: "manualPolling" }],
    },
    {
      code: "for (let attempt = 0; attempt < 3; attempt++) { await timers['sleep'](100); }",
      errors: [{ messageId: "manualPolling" }],
    },
  ],
});
