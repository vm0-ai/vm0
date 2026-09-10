import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import rule from "../rules/no-computed-signal.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-computed-signal", rule, {
  valid: [
    {
      code: `
        import { computed } from "ccstate";

        const value$ = computed((get) => get(source$));
      `,
    },
    {
      code: `
        import { computed } from "ccstate";

        const value$ = computed(async (get) => await get(source$));
      `,
    },
    {
      code: `
        import { computed } from "ccstate";

        const value$ = library.computed((get, options) => options.signal);
      `,
    },
    {
      code: `
        function computed(callback: () => void) {
          return callback;
        }

        computed(() => consume(pageSignal$));
      `,
    },
    {
      code: `
        import { computed } from "another-package";

        computed(() => consume(pageSignal$));
      `,
    },
    {
      code: `
        import { computed } from "ccstate";

        computed(() => resetSignal());
      `,
    },
    {
      code: `
        import { command } from "ccstate";

        const run$ = command(async ({ get }, signal: AbortSignal) => get(source$));
      `,
    },
  ],
  invalid: [
    {
      code: `
        import { computed } from "ccstate";

        const value$ = computed((get, { signal }) => load(signal));
      `,
      errors: [{ messageId: "noComputedSignal" }],
    },
    {
      code: `
        import { computed } from "ccstate";

        const value$ = computed(async (get, { signal: requestSignal }) => load(requestSignal));
      `,
      errors: [{ messageId: "noComputedSignal" }],
    },
    {
      code: `
        import { computed } from "ccstate";

        const value$ = computed(function (get, options) { return load(options.signal); });
      `,
      errors: [{ messageId: "noComputedSignal" }],
    },
    {
      code: `
        import { computed } from "ccstate";

        const value$ = computed((get) => load(get(pageSignal$)));
      `,
      errors: [{ messageId: "noComputedSignal" }],
    },
    {
      code: `
        import { computed } from "ccstate";

        const value$ = computed((get) => load(request.signal));
      `,
      errors: [{ messageId: "noComputedSignal" }],
    },
    {
      code: `
        import { computed } from "ccstate";

        const loader$ = computed((get) => async (page, signal) => load(page, signal));
      `,
      errors: [{ messageId: "noComputedSignal" }],
    },
    {
      code: `
        import { computed } from "ccstate";

        function createValue(owner: AbortSignal) {
          return computed(() => load(owner));
        }
      `,
      errors: [{ messageId: "noComputedSignal" }],
    },
    {
      code: `
        import { computed as createComputed } from "ccstate";

        const value$ = createComputed(() => AbortSignal.abort());
      `,
      errors: [{ messageId: "noComputedSignal" }],
    },
    {
      code: `
        import * as ccstate from "ccstate";

        const value$ = ccstate["computed"](() => load(rootSignal));
      `,
      errors: [{ messageId: "noComputedSignal" }],
    },
    {
      code: `
        import { computed } from "ccstate";

        const value$ = computed(() => {
          consume(pageSignal$);
          consume(rootSignal$);
          return (signal: AbortSignal) => consume(signal);
        });
      `,
      errors: [{ messageId: "noComputedSignal" }],
    },
  ],
});
