import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-detach-in-signals.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-detach-in-signals", rule, {
  valid: [
    // Views layer — detach is allowed
    {
      filename: "/app/src/views/zero-page/my-component.tsx",
      code: `detach(commandFn(pageSignal), Reason.DomCallback);`,
    },
    // Test files — detach is allowed
    {
      filename: "/app/src/signals/__tests__/utils.test.ts",
      code: `detach(Promise.resolve("value"), Reason.Entrance);`,
    },
    // Signals layer — non-detach calls are fine
    {
      filename: "/app/src/signals/route.ts",
      code: `await set(loadRoute$, signal);`,
    },
    // Outside src/signals/ entirely
    {
      filename: "/app/src/lib/helpers.ts",
      code: `detach(someWork(), Reason.Daemon);`,
    },
  ],
  invalid: [
    {
      filename: "/app/src/signals/bootstrap.ts",
      code: `detach(set(initApp$, signal), Reason.Entrance);`,
      errors: [{ messageId: "noDetachInSignals" }],
    },
    {
      filename: "/app/src/signals/route.ts",
      code: `detach(set(loadRoute$, signal), Reason.Daemon);`,
      errors: [{ messageId: "noDetachInSignals" }],
    },
    {
      filename: "/app/src/signals/zero-page/zero-page.ts",
      code: `detach(set(initSlackOrg$, signal), Reason.Entrance);`,
      errors: [{ messageId: "noDetachInSignals" }],
    },
  ],
});
