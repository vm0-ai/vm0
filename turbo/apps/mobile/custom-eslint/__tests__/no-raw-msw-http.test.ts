import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-raw-msw-http.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-raw-msw-http", rule, {
  valid: [
    {
      // Allowed: mockApi() usage
      code: `server.use(mockApi(contract.route, ({ respond }) => respond(200, {})));`,
    },
    {
      // Allowed: http.* against a third-party host (no internal api path)
      code: `server.use(http.post("https://slack.com/api/chat.postMessage", () => HttpResponse.json({})));`,
    },
    {
      // Allowed: http.* against a synthetic, non-api path (fetch-wrapper self-tests)
      code: `server.use(http.get("http://localhost:3000/test", () => HttpResponse.json({})));`,
    },
    {
      // Allowed: method not in the MSW set (e.g. http.options — not enforced)
      code: `server.use(http.options("*/api/zero/org", () => HttpResponse.json({})));`,
    },
    {
      // Allowed: URL arg is a variable — rule only flags string literals to stay conservative
      code: `server.use(http.get(url, () => HttpResponse.json({})));`,
    },
    {
      // Allowed: inline marker comment right before the http.* call
      code: `
        server.use(
          // mockApi cannot be used here: 500 is not declared in the contract's responses.
          http.get("*/api/zero/org", () => HttpResponse.json(null, { status: 500 })),
        );
      `,
    },
    {
      // Allowed: marker comment before the enclosing server.use() statement
      code: `
        // mockApi cannot be used here: the URL contains a literal slash that MSW resolves as a path separator.
        server.use(
          http.get("http://localhost:3000/api/zero/agents/*", () => HttpResponse.json({})),
        );
      `,
    },
    {
      // Allowed: marker comment above the variable declaration that holds the handler
      code: `
        // mockApi cannot be used here: binary streaming response with no ts-rest contract.
        const handler = http.post("http://localhost:3000/api/zero/voice-io/tts", () => new Response());
      `,
    },
  ],
  invalid: [
    {
      code: `server.use(http.get("*/api/zero/org", () => HttpResponse.json({})));`,
      errors: [{ messageId: "useMockApi" }],
    },
    {
      code: `server.use(http.post("*/api/zero/uploads", () => HttpResponse.json({})));`,
      errors: [{ messageId: "useMockApi" }],
    },
    {
      code: `server.use(http.put("http://localhost:3000/api/zero/items/1", () => HttpResponse.json({})));`,
      errors: [{ messageId: "useMockApi" }],
    },
    {
      code: `server.use(http.patch("*/api/zero/team", () => HttpResponse.json({})));`,
      errors: [{ messageId: "useMockApi" }],
    },
    {
      code: `server.use(http.delete("*/api/zero/secrets/:id", () => HttpResponse.json({})));`,
      errors: [{ messageId: "useMockApi" }],
    },
    {
      code: `server.use(http.get("*/api/v1/widgets", () => HttpResponse.json({})));`,
      errors: [{ messageId: "useMockApi" }],
    },
    {
      // Unrelated comment does not exempt
      code: `
        server.use(
          // TODO: revisit this handler
          http.get("*/api/zero/org", () => HttpResponse.json({})),
        );
      `,
      errors: [{ messageId: "useMockApi" }],
    },
  ],
});
