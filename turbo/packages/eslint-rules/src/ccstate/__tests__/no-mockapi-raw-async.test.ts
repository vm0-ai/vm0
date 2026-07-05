import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-mockapi-raw-async.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-mockapi-raw-async", rule, {
  valid: [
    {
      code: `
        server.use(
          mockApi(route, ({ respond, deferred }) => {
            const gate = deferred<void>();
            return gate.promise.then(() => respond(200, {}));
          }),
        );
      `,
    },
    {
      code: `
        server.use(
          mockApi(route, ({ never }) => {
            return never();
          }),
        );
      `,
    },
    {
      code: `
        server.use(
          mockApi(route, async ({ delay, respond }) => {
            await delay(100);
            return respond(200, {});
          }),
        );
      `,
    },
    {
      code: `
        server.use(
          http.put("/upload", ({ request }) => {
            return withSignal(fetch(request), request.signal);
          }),
        );
      `,
    },
    {
      code: `
        new Promise((resolve) => resolve(1));
      `,
    },
    {
      code: `
        setTimeout(() => {}, 100);
      `,
    },
  ],
  invalid: [
    {
      code: `
        server.use(
          mockApi(route, ({ respond }) => {
            return new Promise((resolve) => {
              resolve(respond(200, {}));
            });
          }),
        );
      `,
      errors: [{ messageId: "noRawPromise" }],
    },
    {
      code: `
        server.use(
          mockApi(route, ({ respond }) => {
            setTimeout(() => {}, 100);
            return respond(200, {});
          }),
        );
      `,
      errors: [{ messageId: "noRawTimer" }],
    },
    {
      code: `
        server.use(
          mockApi(route, ({ respond }) => {
            return new Promise((resolve) => {
              setInterval(() => resolve(respond(200, {})), 100);
            });
          }),
        );
      `,
      errors: [{ messageId: "noRawPromise" }, { messageId: "noRawTimer" }],
    },
    {
      code: `
        const gate = new Promise((resolve) => {
          resolver = resolve;
        });
        server.use(
          mockApi(route, async ({ respond }) => {
            await gate;
            return respond(200, {});
          }),
        );
      `,
      errors: [{ messageId: "noExternalPromise" }],
    },
    {
      code: `
        let resolver;
        server.use(
          http.put("/upload", async () => {
            await new Promise((resolve) => {
              resolver = resolve;
            });
            return new Response();
          }),
        );
      `,
      errors: [{ messageId: "noRawPromise" }],
    },
  ],
});
