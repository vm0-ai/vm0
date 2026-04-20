import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-relative-vi-mock.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-relative-vi-mock", rule, {
  valid: [
    {
      code: 'vi.mock("@clerk/nextjs/server", () => ({}));',
    },
    {
      code: 'vi.mock("next/server", () => ({}));',
    },
    {
      code: 'vi.mock("ably", () => ({}));',
    },
    {
      code: 'vi.mock("child_process");',
    },
    {
      code: 'vi.mock("server-only", () => ({}));',
    },
    {
      // doMock with package path is fine
      code: 'vi.doMock("ably", () => ({}));',
    },
    {
      // Not vi.mock - different object
      code: 'jest.mock("../lib/utils");',
    },
    {
      // Not vi.mock - different method
      code: 'vi.fn("../lib/utils");',
    },
    {
      // No arguments
      code: "vi.mock();",
    },
  ],
  invalid: [
    {
      code: 'vi.mock("../lib/utils", () => ({}));',
      errors: [{ messageId: "noRelativeMock" }],
    },
    {
      code: 'vi.mock("./helpers");',
      errors: [{ messageId: "noRelativeMock" }],
    },
    {
      code: 'vi.mock("../../services/auth", () => ({}));',
      errors: [{ messageId: "noRelativeMock" }],
    },
    {
      // doMock with relative path
      code: 'vi.doMock("../lib/utils");',
      errors: [{ messageId: "noRelativeMock" }],
    },
    {
      // Template literal with relative path
      code: "vi.mock(`../lib/utils`);",
      errors: [{ messageId: "noRelativeMock" }],
    },
  ],
});
