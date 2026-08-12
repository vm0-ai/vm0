import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noCrossTestTimeStaggering } from "../rules/no-cross-test-time-staggering.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-cross-test-time-staggering", noCrossTestTimeStaggering, {
  valid: [
    {
      name: "fixed identical hook time is valid",
      code: `
        import { mockNow } from "../../../lib/time";
        const FIXED_NOW = 1_000;
        beforeEach(() => mockNow(FIXED_NOW));
      `,
    },
    {
      name: "TTL progression stays inside its owning test",
      code: `
        import { mockNow, withMockNowForTest } from "../../../lib/time";
        it("expires its cache", async () => {
          const initialNow = 1_000;
          await withMockNowForTest(initialNow, async () => {
            await readManifest();
            mockNow(initialNow + 59_999);
            await readManifest();
            mockNow(initialNow + 60_000);
            await readManifest();
          });
        });
      `,
    },
    {
      name: "clearMockNow teardown stays valid",
      code: `
        import { clearMockNow } from "../../../lib/time";
        afterEach(() => clearMockNow());
      `,
    },
  ],
  invalid: [
    {
      name: "canonical namespace mockNow remains rejected",
      code: `
        import * as time from "../../../lib/time";
        let index = 0;
        beforeEach(() => time.mockNow(1_000 + index++ * 60_000));
      `,
      errors: [{ messageId: "sharedTime" }],
    },
    {
      name: "multi-hop local mockNow aliases remain rejected",
      code: `
        import { mockNow } from "../../../lib/time";
        const first = mockNow;
        const second = first;
        let index = 0;
        beforeEach(() => second(1_000 + index++ * 60_000));
      `,
      errors: [{ messageId: "sharedTime" }],
    },
    {
      name: "module counter incremented after a beforeEach mock is rejected",
      code: `
        import { mockNow } from "../../../lib/time";
        let cacheIndex = 0;
        beforeEach(() => {
          mockNow(1_000 + cacheIndex * 60_000);
          cacheIndex += 1;
        });
      `,
      errors: [{ messageId: "sharedTime" }],
    },
    {
      name: "describe counter incremented before the hook mock is rejected",
      code: `
        import { mockNow } from "../../../lib/time";
        describe("cache", () => {
          let sequence = 0;
          beforeEach(() => {
            sequence++;
            mockNow(1_000 + sequence * 60_000);
          });
        });
      `,
      errors: [{ messageId: "sharedTime" }],
    },
    {
      name: "aliased hook and mockNow remain rejected",
      code: `
        import { beforeEach as setup } from "vitest";
        import { mockNow as setClock } from "../../../lib/time";
        let testOrder = 0;
        setup(() => setClock(1_000 + testOrder++ * 60_000));
      `,
      errors: [{ messageId: "sharedTime" }],
    },
    {
      name: "hook-called wrapper cannot hide shared order",
      code: `
        import { beforeEach as setup } from "vitest";
        import { mockNow as setClock } from "../../../lib/time";
        let suiteIndex = 0;
        function setCacheTime(value) { setClock(value); }
        setup(() => {
          setCacheTime(1_000 + suiteIndex * 60_000);
          suiteIndex++;
        });
      `,
      errors: [{ messageId: "sharedTime" }],
    },
    {
      name: "afterEach staggering remains rejected",
      code: `
        import { mockNow } from "../../../lib/time";
        let index = 0;
        afterEach(() => mockNow(1_000 + ++index * 60_000));
      `,
      errors: [{ messageId: "sharedTime" }],
    },
    {
      name: "aliased describe scope remains suite-shared",
      code: `
        import { describe as suite } from "vitest";
        import { mockNow } from "../../../lib/time";
        suite("cache", () => {
          let index = 0;
          beforeEach(() => mockNow(1_000 + index++ * 60_000));
        });
      `,
      errors: [{ messageId: "sharedTime" }],
    },
    {
      name: "module-scoped mutable object member is rejected",
      code: `
        import { mockNow } from "../../../lib/time";
        const clock = { index: 0 };
        beforeEach(() => mockNow(1_000 + clock.index++ * 60_000));
      `,
      errors: [{ messageId: "sharedTime" }],
    },
    {
      name: "describe-scoped mutable object member is rejected",
      code: `
        import { mockNow } from "../../../lib/time";
        describe("cache", () => {
          const clock = { index: 0 };
          beforeEach(() => mockNow(1_000 + clock.index * 60_000));
          afterEach(() => { clock.index += 1; });
        });
      `,
      errors: [{ messageId: "sharedTime" }],
    },
    {
      name: "local alias of mockNow remains rejected",
      code: `
        import { mockNow } from "../../../lib/time";
        const setClock = mockNow;
        let index = 0;
        beforeEach(() => setClock(1_000 + index++ * 60_000));
      `,
      errors: [{ messageId: "sharedTime" }],
    },
  ],
});
