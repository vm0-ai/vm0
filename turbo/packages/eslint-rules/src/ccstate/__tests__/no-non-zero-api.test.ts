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
      code: 'const url = "/api/okou/billing/status"',
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
    // #28460's MSW patterns, and the connector OAuth callback that was neutral
    // before the slice: `/api/connectors` covers everything below it, so this
    // path stops being distinguishable once the family moves.
    {
      code: 'context.mocks.http.get("*/api/connector-catalog/status", handler)',
    },
    {
      code: "fetchFn(`/api/custom-connectors/${id}/values`)",
    },
    {
      code: 'window.open("/api/connectors/github/callback")',
    },
    // #28461 moved the agent, workflow, and workflow-automation routes, so the
    // MSW patterns the platform tests register are accepted with their route
    // parameters still in template form.
    {
      code: 'context.mocks.http.get("*/api/agents/:id/user-connectors", handler)',
    },
    {
      code: "fetchFn(`/api/workflows/${workflowId}/publish`)",
    },
  ],
  invalid: [
    {
      code: 'const url = "/api/zero/billing/status"',
      errors: [{ messageId: "nonZeroApi" }],
    },
    {
      code: 'fetchFn("/api/billing/status")',
      errors: [{ messageId: "nonZeroApi" }],
    },
    {
      code: 'const url = "/api/usage/members"',
      errors: [{ messageId: "nonZeroApi" }],
    },
    // A longer sibling of a migrated connector path is not itself migrated.
    {
      code: 'fetchFn("/api/connectors-legacy/github")',
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
    // A neutral path whose contract has not moved yet stays a violation. The
    // subject has to be a family no slice has migrated: #28459 added
    // `/api/chat-threads` to the allow list, which made the previous subject
    // legal and left this case asserting the opposite of the rule.
    {
      code: 'fetchFn("/api/memory/entries")',
      errors: [{ messageId: "nonZeroApi" }],
    },
  ],
});
