import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-non-zero-api.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-non-zero-api", rule, {
  valid: [
    // Current Platform calls use the canonical Okou namespace.
    {
      code: 'const url = "/api/okou/org"',
    },
    {
      code: "fetchFn(`/api/okou/agents/${agentId}`)",
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
    // Neutral paths #28278 has already moved off the brand namespace, in the
    // forms the platform writes them: the request itself and the MSW pattern
    // its test registers.
    {
      code: 'fetchFn("/api/push-subscriptions")',
    },
    {
      code: 'context.mocks.http.post("*/api/push-subscriptions", handler)',
    },
    // A migrated route reached below its listed prefix, including the template
    // form with the parameter already substituted.
    {
      code: 'fetchFn("/api/artifacts/catalog?kind=avatar")',
    },
    {
      code: "fetchFn(`/api/runs/${runId}/context`)",
    },
    // #28457 moved the whole billing surface, so the prefix covers a nested
    // path and a substituted parameter alike.
    {
      code: 'fetchFn("/api/billing/status")',
    },
    {
      code: "fetchFn(`/api/billing/redeem/${campaign}`)",
    },
  ],
  invalid: [
    {
      code: 'const url = "/api/zero/org"',
      errors: [{ messageId: "nonZeroApi" }],
    },
    // A longer sibling of the billing prefix is a different route family, so
    // #28457's allow-list entry must not reach it.
    {
      code: 'fetchFn("/api/billing-exports/status")',
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
    {
      code: 'const path = "/api/okou-internal/agents"',
      errors: [{ messageId: "nonZeroApi" }],
    },
    // A longer sibling of a migrated path is not itself migrated, so the allow
    // list must not match it by prefix.
    {
      code: 'fetchFn("/api/push-subscriptions-legacy")',
      errors: [{ messageId: "nonZeroApi" }],
    },
    // A neutral path whose contract has not moved yet stays a violation.
    {
      code: 'fetchFn("/api/chat-threads/snapshot")',
      errors: [{ messageId: "nonZeroApi" }],
    },
  ],
});
