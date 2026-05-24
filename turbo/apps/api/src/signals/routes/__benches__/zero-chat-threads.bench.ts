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

describe("bench GET /api/zero/chat-threads/:id", () => {
  let fixture: ZeroChatThreadFixture;
  const client = setupApp({ context })(chatThreadByIdContract);

  beforeAll(async () => {
    fixture = await store.set(
      seedZeroChatThread$,
      { title: "bench" },
      context.signal,
    );

    for (let i = 0; i < RUN_COUNT; i++) {
      const status = STATUSES[i % STATUSES.length];
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId: fixture.composeId,
          chatThreadId: fixture.threadId,
          status,
          completedAt: status === "completed" ? nowDate() : null,
        },
        context.signal,
      );
    }

    mocks.clerk.session(fixture.userId, fixture.orgId);

    // Sanity-check the request before the bench measures it — tinybench
    // silently swallows per-iteration errors, so a misconfigured fixture
    // would yield an empty samples array without a visible failure.
    const sanity = await client.get({
      params: { id: fixture.threadId },
      headers: { authorization: "Bearer clerk-session" },
    });
    if (sanity.status !== 200) {
      throw new Error(
        `sanity check failed: status=${String(sanity.status)} body=${JSON.stringify(sanity.body)}`,
      );
    }
  });

  bench(
    "current",
    async () => {
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
