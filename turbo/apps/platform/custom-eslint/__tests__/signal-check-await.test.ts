import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/signal-check-await.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("signal-check-await", rule, {
  valid: [
    {
      code: `
        command(async ({ signal }) => {
          const data = await fetch(url);
          signal.throwIfAborted();
          process(data);
        })
      `,
    },
    {
      code: `
        command(async ({ signal }) => {
          const data = await fetch(url);
          if (signal.aborted) return;
          process(data);
        })
      `,
    },
    {
      code: `
        command(async () => {
          const data = await fetch(url);
          process(data);
        })
      `,
    },
    {
      code: `
        async function normalFunction({ signal }) {
          const data = await fetch(url);
          process(data);
        }
      `,
    },
    {
      code: `
        command(({ signal }) => {
          const data = getData();
          process(data);
        })
      `,
    },
  ],
  invalid: [
    {
      code: `
        command(async ({ signal }) => {
          const data = await fetch(url);
          process(data);
        })
      `,
      errors: [{ messageId: "missingSignalCheck" }],
    },
    {
      code: `
        command(async ({ signal }) => {
          await step1();
          await step2();
        })
      `,
      errors: [{ messageId: "missingSignalCheck" }],
    },
    {
      code: `
        command(async ({ signal }) => {
          await step1();
          await step2();
          doSomething();
        })
      `,
      errors: [
        { messageId: "missingSignalCheck" },
        { messageId: "missingSignalCheck" },
      ],
    },
    // Case 1: signal in destructuring (no type) - SHOULD DETECT ✅
    {
      code: `
        command(async ({ signal }) => {
          signal.throwIfAborted();
          const cursor = await getSomething();
          doSomething(cursor);
        })
      `,
      errors: [{ messageId: "missingSignalCheck" }],
    },
    // Case 2: signal in destructuring (with type) - SHOULD DETECT ✅
    {
      code: `
        command(async ({ signal }: { signal: AbortSignal }) => {
          signal.throwIfAborted();
          const cursor = await getSomething();
          doSomething(cursor);
        })
      `,
      errors: [{ messageId: "missingSignalCheck" }],
    },
    // Case 3: signal as first standalone parameter - SHOULD DETECT BUT DOESN'T ❌
    {
      code: `
        command(async (signal: AbortSignal) => {
          signal.throwIfAborted();
          const cursor = await getSomething();
          doSomething(cursor);
        })
      `,
      errors: [{ messageId: "missingSignalCheck" }],
    },
    // Case 4: signal as second standalone parameter (actual PR 1373 pattern) - SHOULD DETECT BUT DOESN'T ❌
    {
      code: `
        command(async ({ get, set }, signal: AbortSignal) => {
          signal.throwIfAborted();
          const cursor = await get(currentCursor$);
          const newComputed = createLogsFetch(cursor);
          set(setLogs$, (prev) => [...prev, newComputed]);
        })
      `,
      errors: [{ messageId: "missingSignalCheck" }],
    },
  ],
});
