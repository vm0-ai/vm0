import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-use-ccstate-in-views.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-use-ccstate-in-views", rule, {
  valid: [
    // OK: experimental import in signals/ (not views/)
    {
      code: 'import { useCCState } from "ccstate-react/experimental"',
      filename: "/project/src/signals/zero-page/zero-chat.ts",
    },
    // OK: non-experimental import in views/
    {
      code: 'import { useGet } from "ccstate-react"',
      filename: "/project/src/views/zero-page/zero-chat-page.tsx",
    },
    // OK: React useState in views/
    {
      code: 'import { useState } from "react"',
      filename: "/project/src/views/zero-page/zero-chat-page.tsx",
    },
    // OK: experimental import in tests/
    {
      code: 'import { useCCState } from "ccstate-react/experimental"',
      filename: "/project/src/__tests__/test.tsx",
    },
  ],
  invalid: [
    // Bad: useCCState from experimental in views/
    {
      code: 'import { useCCState } from "ccstate-react/experimental"',
      filename: "/project/src/views/zero-page/zero-chat-page.tsx",
      errors: [{ messageId: "noExperimentalImport" }],
    },
    // Bad: useCommand from experimental in views/
    {
      code: 'import { useCommand } from "ccstate-react/experimental"',
      filename: "/project/src/views/zero-page/zero-activity-page.tsx",
      errors: [{ messageId: "noExperimentalImport" }],
    },
    // Bad: multiple imports from experimental in views/
    {
      code: 'import { useCCState, useCommand } from "ccstate-react/experimental"',
      filename: "/project/src/views/zero-page/zero-sidebar.tsx",
      errors: [{ messageId: "noExperimentalImport" }],
    },
  ],
});
