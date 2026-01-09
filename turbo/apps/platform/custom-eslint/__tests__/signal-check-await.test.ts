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
  ],
});
