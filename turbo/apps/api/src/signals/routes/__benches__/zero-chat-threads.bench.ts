import { createStore } from "ccstate";
import { bench } from "vitest";
import { chatThreadByIdContract } from "@vm0/api-contracts/contracts/chat-threads";

import { setupApp, testContext } from "../../../__tests__/test-helpers";
import { nowDate } from "../../external/time";
import {
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "../__tests__/helpers/zero-chat-threads";
import { seedRun$ } from "../__tests__/helpers/zero-usage-insight";
import { createZeroRouteMocks } from "../__tests__/helpers/zero-route-test";

// HTTP-level benchmark for GET /api/zero/chat-threads/:id. The handler currently
// issues 4 nearly identical `zero_runs INNER JOIN agent_runs` queries; this
// bench establishes the baseline so a follow-up refactor (merge into 1 query)
// can be measured against it via CI artifact diff.
//
// Fixture seeding runs lazily inside the first bench iteration (not in
// `beforeAll`) because vitest 4 does not bridge `beforeAll` into bench mode:
// iterations would otherwise see an unseeded DB, error silently in
// tinybench, and produce empty samples without failing the suite.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const RUN_COUNT = 50;
const STATUSES = ["completed", "completed", "failed", "running"] as const;

const client = setupApp({ context })(chatThreadByIdContract);

const ensureSeeded: () => Promise<ZeroChatThreadFixture> = (() => {
  let cached: Promise<ZeroChatThreadFixture> | undefined;
  return () => {
    cached ??= (async () => {
      const seeded = await store.set(
        seedZeroChatThread$,
        { title: "bench" },
        context.signal,
      );
      for (let i = 0; i < RUN_COUNT; i++) {
        const status = STATUSES[i % STATUSES.length];
        await store.set(
          seedRun$,
          {
            orgId: seeded.orgId,
            userId: seeded.userId,
            composeId: seeded.composeId,
            chatThreadId: seeded.threadId,
            status,
            completedAt: status === "completed" ? nowDate() : null,
          },
          context.signal,
        );
      }
      mocks.clerk.session(seeded.userId, seeded.orgId);
      const sanity = await client.get({
        params: { id: seeded.threadId },
        headers: { authorization: "Bearer clerk-session" },
      });
      if (sanity.status !== 200) {
        throw new Error(
          `sanity check failed: status=${String(sanity.status)} body=${JSON.stringify(sanity.body)}`,
        );
      }
      return seeded;
    })();
    return cached;
  };
})();

describe("bench GET /api/zero/chat-threads/:id", () => {
  bench(
    "current",
    async () => {
      const fixture = await ensureSeeded();
      const response = await client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    },
    { time: 5000, warmupIterations: 5 },
  );
});
