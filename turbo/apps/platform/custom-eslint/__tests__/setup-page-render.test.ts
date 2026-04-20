import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/setup-page-render.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("setup-page-render", rule, {
  valid: [
    // Signal tests with withoutRender: true
    {
      code: 'setupPage({ context, path: "/", withoutRender: true })',
      filename: "/project/src/signals/__tests__/fetch.test.ts",
    },
    {
      code: 'setupPage({ context, path: "/", session: { token: "t" }, withoutRender: true })',
      filename:
        "/project/src/signals/external/__tests__/model-providers.test.ts",
    },
    // View tests without withoutRender
    {
      code: 'setupPage({ context, path: "/" })',
      filename: "/project/src/views/home/__tests__/home-page.test.tsx",
    },
    {
      code: 'setupPage({ context, path: "/logs" })',
      filename: "/project/src/views/logs-page/__tests__/logs-page.test.tsx",
    },
    // Other directories are not checked
    {
      code: 'setupPage({ context, path: "/" })',
      filename: "/project/src/__tests__/setup-page.test.ts",
    },
    {
      code: 'setupPage({ context, path: "/", withoutRender: true })',
      filename: "/project/src/__tests__/other.test.ts",
    },
  ],
  invalid: [
    // Signal tests missing withoutRender
    {
      code: 'setupPage({ context, path: "/" })',
      filename: "/project/src/signals/__tests__/onboarding.test.ts",
      errors: [{ messageId: "missingWithoutRender" }],
    },
    {
      code: 'setupPage({ context, path: "/", session: { token: "t" } })',
      filename:
        "/project/src/signals/agents-page/__tests__/agents-list.test.ts",
      errors: [{ messageId: "missingWithoutRender" }],
    },
    // View tests with withoutRender
    {
      code: 'setupPage({ context, path: "/", withoutRender: true })',
      filename: "/project/src/views/home/__tests__/home-page.test.tsx",
      errors: [{ messageId: "forbiddenWithoutRender" }],
    },
    {
      code: 'setupPage({ context, path: "/logs", withoutRender: true })',
      filename:
        "/project/src/views/logs-page/__tests__/log-detail-page.test.tsx",
      errors: [{ messageId: "forbiddenWithoutRender" }],
    },
  ],
});
