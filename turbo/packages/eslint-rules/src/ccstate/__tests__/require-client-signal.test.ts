import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/require-client-signal.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const SIGNALS_FILE = "/app/src/signals/zero-page/billing.ts";
const TEST_FILE = "/app/src/signals/__tests__/billing.test.ts";

ruleTester.run("require-client-signal", rule, {
  valid: [
    {
      filename: SIGNALS_FILE,
      code: `
        const load$ = command(async ({ get }, signal: AbortSignal) => {
          const createClient = get(zeroClient$);
          const client = createClient(someContract);
          await accept(client.get({ fetchOptions: { signal } }), [200]);
        });
      `,
    },
    {
      filename: SIGNALS_FILE,
      code: `
        const save$ = command(async ({ get }, value: string, signal: AbortSignal) => {
          const createClient = get(zeroClient$);
          const client = createClient(someContract);
          await accept(
            client.update({
              body: { value },
              fetchOptions: { signal },
            }),
            [200],
          );
        });
      `,
    },
    {
      filename: SIGNALS_FILE,
      code: `
        const helper = async (signal: AbortSignal) => {
          const createClient = get(zeroClient$);
          const client = createClient(someContract);
          return accept(client.list({ query: { q: "x" }, fetchOptions: { signal } }), [200]);
        };
      `,
    },
    {
      filename: SIGNALS_FILE,
      code: `
        const upload$ = command(async ({ get, set }, parentSignal: AbortSignal) => {
          const signal = set(resetSignal$, parentSignal);
          const client = get(zeroClient$)(someContract);
          await accept(
            client.create({
              body: {},
              fetchOptions: { signal },
            }),
            [200],
          );
        });
      `,
    },
    {
      filename: SIGNALS_FILE,
      code: `
        const value$ = computed(async (get) => {
          const createClient = get(zeroClient$);
          const client = createClient(someContract);
          return accept(client.get(), [200]);
        });
      `,
    },
    {
      filename: SIGNALS_FILE,
      code: `
        const load$ = command(async ({ get }) => {
          const client = get(zeroClient$)(someContract);
          await accept(client.get(), [200]);
        });
      `,
    },
    {
      filename: TEST_FILE,
      code: `
        const load$ = command(async ({ get }, signal: AbortSignal) => {
          const createClient = get(zeroClient$);
          const client = createClient(someContract);
          await accept(client.get(), [200]);
        });
      `,
    },
  ],
  invalid: [
    {
      filename: SIGNALS_FILE,
      code: `
        const load$ = command(async ({ get }, signal: AbortSignal) => {
          const createClient = get(zeroClient$);
          const client = createClient(someContract);
          await accept(client.get(), [200]);
        });
      `,
      errors: [{ messageId: "missingFetchOptions" }],
    },
    {
      filename: SIGNALS_FILE,
      code: `
        const load$ = command(async ({ get }, signal: AbortSignal) => {
          const createClient = get(zeroClient$);
          const client = createClient(someContract);
          await accept(client.get({ query: { q: "x" } }), [200]);
        });
      `,
      errors: [{ messageId: "missingFetchOptions" }],
    },
    {
      filename: SIGNALS_FILE,
      code: `
        const load$ = command(async ({ get }, signal: AbortSignal) => {
          const createClient = get(zeroClient$);
          const client = createClient(someContract);
          await accept(client.get({ fetchOptions: {} }), [200]);
        });
      `,
      errors: [{ messageId: "missingSignal" }],
    },
    {
      filename: SIGNALS_FILE,
      code: `
        const helper = async (signal: AbortSignal) => {
          const createClient = get(zeroClient$);
          const client = createClient(someContract);
          return accept(client.delete({ params: { id: "123" } }), [204]);
        };
      `,
      errors: [{ messageId: "missingFetchOptions" }],
    },
    {
      filename: SIGNALS_FILE,
      code: `
        const load$ = command(async ({ get }, signal: AbortSignal) => {
          const controller = new AbortController();
          const otherSignal = controller.signal;
          const createClient = get(zeroClient$);
          const client = createClient(someContract);
          await accept(
            client.get({
              fetchOptions: { signal: otherSignal },
            }),
            [200],
          );
        });
      `,
      errors: [{ messageId: "wrongSignal" }],
    },
  ],
});
