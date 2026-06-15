import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-non-zero-api.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-non-zero-api", rule, {
  valid: [
    // Zero API paths are allowed
    {
      code: 'const url = "/api/zero/billing/status"',
    },
    {
      code: 'fetchFn("/api/zero/agents")',
    },
    // Non-API strings are fine
    {
      code: 'const msg = "hello world"',
    },
    {
      code: 'const path = "/dashboard/settings"',
    },
    // Partial path that doesn't contain /api/
    {
      code: 'const doc = "See the API docs at /docs/api"',
    },
    // External URLs with /api/ are allowed (e.g. Slack, Stripe)
    {
      code: 'const url = "https://slack.com/api/chat.postMessage"',
    },
    {
      code: 'const url = "http://example.com/api/something"',
    },
  ],
  invalid: [
    {
      code: 'fetchFn("/api/billing/status")',
      errors: [{ messageId: "nonZeroApi" }],
    },
    {
      code: 'const url = "/api/usage/members"',
      errors: [{ messageId: "nonZeroApi" }],
    },
    {
      code: 'window.open("/api/connectors/github/callback")',
      errors: [{ messageId: "nonZeroApi" }],
    },
    {
      code: 'const path = "/api/agent/composes/123/instructions"',
      errors: [{ messageId: "nonZeroApi" }],
    },
  ],
});
