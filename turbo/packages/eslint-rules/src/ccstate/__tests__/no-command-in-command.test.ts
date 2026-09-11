import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import rule from "../rules/no-command-in-command.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-command-in-command", rule, {
  valid: [
    {
      code: `
        import { command } from "ccstate";

        const child$ = command(({ set }, value: number) => set(value$, value));
        const parent$ = command(({ set }) => set(child$, 1));
      `,
    },
    {
      code: `
        function command(callback: () => void) {
          return callback;
        }

        command(() => command(() => {}));
      `,
    },
    {
      code: `
        import { command } from "another-package";

        command(() => command(() => {}));
      `,
    },
    {
      code: `
        import { command } from "ccstate";

        command(() => {
          const localCommand = (callback: () => void) => callback;
          localCommand(() => localCommand(() => {}));
        });
      `,
    },
    {
      code: `
        import { command } from "ccstate";

        command(() => {
          const command = (callback: () => void) => callback;
          command(() => {});
        });
      `,
    },
  ],
  invalid: [
    {
      code: `
        import { command } from "ccstate";

        command(({ set }) => {
          const child$ = command(({ set }) => set(value$, 1));
          return set(child$);
        });
      `,
      errors: [{ messageId: "nestedCommand" }],
    },
    {
      code: `
        import { command as createCommand } from "ccstate";

        createCommand(() => {
          run(() => createCommand(() => {}));
        });
      `,
      errors: [{ messageId: "nestedCommand" }],
    },
    {
      code: `
        import * as ccstate from "ccstate";

        ccstate.command(function () {
          return ccstate["command"](() => {});
        });
      `,
      errors: [{ messageId: "nestedCommand" }],
    },
    {
      code: `
        import { command } from "ccstate";

        command(() => command(() => command(() => {})));
      `,
      errors: [{ messageId: "nestedCommand" }, { messageId: "nestedCommand" }],
    },
  ],
});
