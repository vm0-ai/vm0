import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { builtInGenerationJobs } from "@vm0/db/schema/built-in-generation-job";
import { testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface BuiltInGenerationFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function seedBuiltInGenerationFixture(): Promise<BuiltInGenerationFixture> {
  return Promise.resolve({
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  });
}

async function deleteBuiltInGenerationFixture(
  fixture: BuiltInGenerationFixture,
): Promise<void> {
  await store
    .set(writeDb$)
    .delete(builtInGenerationJobs)
    .where(eq(builtInGenerationJobs.orgId, fixture.orgId));
}

describe("GET /api/zero/built-in-generations/:generationId", () => {
  const track = createFixtureTracker<BuiltInGenerationFixture>(
    deleteBuiltInGenerationFixture,
  );

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

  it("marks stale active jobs as failed when status is read", async () => {
    const currentTime = new Date("2026-05-15T12:00:00.000Z");
    mockNow(currentTime);
    const fixture = await track(seedBuiltInGenerationFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const generationId = randomUUID();
    const staleAt = new Date(currentTime.getTime() - 16 * 60 * 1000);

    await store
      .set(writeDb$)
      .insert(builtInGenerationJobs)
      .values({
        id: generationId,
        type: "image",
        status: "running",
        orgId: fixture.orgId,
        userId: fixture.userId,
        request: { prompt: "stale image" },
        createdAt: staleAt,
        updatedAt: staleAt,
        startedAt: staleAt,
      });

    const app = createApp({ signal: context.signal });
    const response = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      generationId,
      type: "image",
      status: "failed",
      error: {
        message: "Generation timed out. Please try again.",
        code: "GENERATION_TIMEOUT",
      },
      completedAt: currentTime.toISOString(),
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${generationId}`,
      expect.objectContaining({
        generationId,
        type: "image",
        status: "failed",
      }),
    );

    const [job] = await store
      .set(writeDb$)
      .select({
        status: builtInGenerationJobs.status,
        error: builtInGenerationJobs.error,
        completedAt: builtInGenerationJobs.completedAt,
      })
      .from(builtInGenerationJobs)
      .where(eq(builtInGenerationJobs.id, generationId));
    expect(job).toMatchObject({
      status: "failed",
      error: {
        message: "Generation timed out. Please try again.",
        code: "GENERATION_TIMEOUT",
      },
    });
    expect(job?.completedAt?.toISOString()).toBe(currentTime.toISOString());
  });

  it("leaves active jobs running before the timeout window", async () => {
    const currentTime = new Date("2026-05-15T12:00:00.000Z");
    mockNow(currentTime);
    const fixture = await track(seedBuiltInGenerationFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const generationId = randomUUID();
    const freshAt = new Date(currentTime.getTime() - 14 * 60 * 1000);

    await store
      .set(writeDb$)
      .insert(builtInGenerationJobs)
      .values({
        id: generationId,
        type: "image",
        status: "running",
        orgId: fixture.orgId,
        userId: fixture.userId,
        request: { prompt: "fresh image" },
        createdAt: freshAt,
        updatedAt: freshAt,
        startedAt: freshAt,
      });

    const app = createApp({ signal: context.signal });
    const response = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      generationId,
      type: "image",
      status: "running",
      completedAt: null,
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});
