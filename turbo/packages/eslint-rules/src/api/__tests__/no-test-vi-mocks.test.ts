import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noTestViMocks } from "../rules/no-test-vi-mocks.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-test-vi-mocks", noTestViMocks, {
  valid: [
    { code: "vi.resetModules();" },
    { code: "context.mocks.clerk.authenticateRequest.mockResolvedValue({});" },
    { code: "mocks.sentry.captureException.mockReset();" },
    { code: "const value = vi;" },
  ],
  invalid: [
    {
      code: 'vi.mock("@clerk/backend", () => ({}));',
      errors: [{ messageId: "noTestViMock" }],
    },
    {
      code: 'vi.spyOn(console, "error");',
      errors: [{ messageId: "noTestViMock" }],
    },
    {
      code: 'vi.stubGlobal("fetch", mockFetch);',
      errors: [{ messageId: "noTestViMock" }],
    },
    {
      code: "const mock = vi.fn();",
      errors: [{ messageId: "noTestViMock" }],
    },
    {
      code: "const mocks = vi.hoisted(() => ({}));",
      errors: [{ messageId: "noTestViMock" }],
    },
    {
      code: 'import { vi as vitest } from "vitest"; vitest.mock("pkg");',
      errors: [{ messageId: "noTestViMock" }],
    },
  ],
});
