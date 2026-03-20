import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-use-ccstate-in-views.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-use-ccstate-in-views", rule, {
  valid: [
    {
      code: 'const input$ = useCCState("")',
      filename: "/project/src/signals/zero-page/zero-chat.ts",
    },
    {
      code: "const value = useGet(someSignal$)",
      filename: "/project/src/views/zero-page/zero-chat-page.tsx",
    },
    {
      code: 'const [value, setValue] = useState("")',
      filename: "/project/src/views/zero-page/zero-chat-page.tsx",
    },
    {
      code: 'const input$ = useCCState("")',
      filename: "/project/src/__tests__/test.tsx",
    },
  ],
  invalid: [
    {
      code: 'const input$ = useCCState("")',
      filename: "/project/src/views/zero-page/zero-chat-page.tsx",
      errors: [{ messageId: "noUseCCStateInViews" }],
    },
    {
      code: "const flag$ = useCCState(false)",
      filename: "/project/src/views/zero-page/zero-sidebar.tsx",
      errors: [{ messageId: "noUseCCStateInViews" }],
    },
  ],
});
