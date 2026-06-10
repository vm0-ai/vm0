import { randomUUID } from "node:crypto";

import { zeroBuiltInGenerationContract } from "@vm0/api-contracts/contracts/zero-built-in-generation";
import { builtInGenerationJobs } from "@vm0/db/schema/built-in-generation-job";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-built-in-generation.test.ts`. The
// Given seeds jobs through `writeDb$` (recorded as an "Open Helper Gap"
// in `api.bdd.md` — no public route creates a built-in generation job
// row; jobs are produced by a webhook). The legacy direct SELECT to
// verify the post-mutation state is replaced by assertions on the GET
// contract response (which already carries the row state).

interface BuiltInGenerationFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function seedFixture(): BuiltInGenerationFixture {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

async function deleteFixture(fixture: BuiltInGenerationFixture): Promise<void> {
  await store
    .set(writeDb$)
    .delete(builtInGenerationJobs)
    .where(eq(builtInGenerationJobs.orgId, fixture.orgId));
}

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const track = createFixtureTracker<BuiltInGenerationFixture>(deleteFixture);

function client() {
  return setupApp({ context })(zeroBuiltInGenerationContract);
}

describe("BDD GET /api/zero/built-in-generations/:id — stale vs fresh chain", () => {
  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.ably.publish.mockReset();
    context.mocks.ably.publish.mockResolvedValue(undefined);
  });

  afterEach(() => {
    clearMockNow();
  });

  it("gwt-wt-wt: stale active job fails on read → fresh active job stays running", async () => {
    // Given: a frozen "now" 16 minutes after a running job's last
    // update. The job is past the stale threshold.
    const currentTime = new Date("2026-05-15T12:00:00.000Z");
    mockNow(currentTime);
    const fixture = await track(Promise.resolve(seedFixture()));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const staleGenerationId = randomUUID();
    const staleAt = new Date(currentTime.getTime() - 16 * 60 * 1000);
    await store
      .set(writeDb$)
      .insert(builtInGenerationJobs)
      .values({
        id: staleGenerationId,
        type: "image",
        status: "running",
        orgId: fixture.orgId,
        userId: fixture.userId,
        request: { prompt: "stale image" },
        createdAt: staleAt,
        updatedAt: staleAt,
        startedAt: staleAt,
      });

    // When: the route reads the job.
    const stale = await accept(
      client().get({
        params: { generationId: staleGenerationId },
        headers: authHeaders(),
      }),
      [200],
    );

    // Then: the response reports the job was marked failed; the Ably
    // realtime channel was published to with the new status.
    expect(stale.body).toMatchObject({
      generationId: staleGenerationId,
      type: "image",
      status: "failed",
      error: {
        message: "Generation timed out. Please try again.",
        code: "GENERATION_TIMEOUT",
      },
      completedAt: currentTime.toISOString(),
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${staleGenerationId}`,
      expect.objectContaining({
        generationId: staleGenerationId,
        type: "image",
        status: "failed",
      }),
    );

    // Given: a fresh active job — last update 14 minutes ago, inside
    // the timeout window.
    const freshGenerationId = randomUUID();
    const freshAt = new Date(currentTime.getTime() - 14 * 60 * 1000);
    await store
      .set(writeDb$)
      .insert(builtInGenerationJobs)
      .values({
        id: freshGenerationId,
        type: "image",
        status: "running",
        orgId: fixture.orgId,
        userId: fixture.userId,
        request: { prompt: "fresh image" },
        createdAt: freshAt,
        updatedAt: freshAt,
        startedAt: freshAt,
      });

    // When: the route reads the fresh job.
    const fresh = await accept(
      client().get({
        params: { generationId: freshGenerationId },
        headers: authHeaders(),
      }),
      [200],
    );

    // Then: the response keeps status=running with completedAt=null and
    // no Ably publish was emitted for this generation.
    expect(fresh.body).toMatchObject({
      generationId: freshGenerationId,
      type: "image",
      status: "running",
      completedAt: null,
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `built-in-generation:${freshGenerationId}`,
      expect.anything(),
    );
  });
});
