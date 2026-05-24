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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const RUN_COUNT = 50;
const STATUSES = ["completed", "completed", "failed", "running"] as const;

const client = setupApp({ context })(chatThreadByIdContract);

let fixture: ZeroChatThreadFixture | undefined;
let initPromise: Promise<void> | undefined;

function ensureSeeded(): Promise<void> {
  initPromise ??= (async () => {
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

    fixture = seeded;
  })();
  return initPromise;
}

describe("bench GET /api/zero/chat-threads/:id", () => {
  let iterCount = 0;
  bench(
    "current",
    async () => {
      await ensureSeeded();
      if (!fixture) {
        throw new Error("fixture missing after seed");
      }
      iterCount += 1;
      const start = performance.now();
      const response = await client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      });
      const elapsed = performance.now() - start;
      // eslint-disable-next-line no-console
      console.log(
        `[bench-iter] ${String(iterCount)} status=${String(response.status)} elapsed=${elapsed.toFixed(2)}ms`,
      );
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    },
    { iterations: 5, time: 0, warmupIterations: 1 },
  );
});
