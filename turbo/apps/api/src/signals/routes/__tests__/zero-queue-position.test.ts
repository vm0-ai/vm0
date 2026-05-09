import { randomUUID } from "node:crypto";

import { zeroQueuePositionContract } from "@vm0/api-contracts/contracts/zero-queue-position";
import { createStore } from "ccstate";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteQueuePositionRuns$,
  seedQueuePositionRuns$,
  type QueuePositionFixture,
} from "./helpers/zero-queue-position";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/queue-position", () => {
  const track = createFixtureTracker<QueuePositionFixture>((fixture) => {
    return store.set(deleteQueuePositionRuns$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroQueuePositionContract);

    const response = await accept(
      client.getPosition({
        query: { runId: randomUUID() },
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 when runId is missing before auth", async () => {
    const app = createApp({
      signal: context.signal,
    });

    const response = await app.request("/api/zero/queue-position", {
      method: "GET",
    });

    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(JSON.stringify(body)).toContain("runId");
  });

  it("returns the queued run position within the org queue", async () => {
    const fixture = await track(
      store.set(seedQueuePositionRuns$, { queuedRuns: 2 }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const runId = fixture.queuedRunIds[1];
    if (!runId) {
      throw new Error("Expected queued run fixture");
    }

    const client = setupApp({ context })(zeroQueuePositionContract);

    const response = await accept(
      client.getPosition({
        query: { runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      position: 2,
      total: 2,
    });
  });

  it("returns zero position for an owned run that is not queued", async () => {
    const fixture = await track(
      store.set(seedQueuePositionRuns$, { unqueuedRuns: 1 }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const runId = fixture.unqueuedRunIds[0];
    if (!runId) {
      throw new Error("Expected unqueued run fixture");
    }

    const client = setupApp({ context })(zeroQueuePositionContract);

    const response = await accept(
      client.getPosition({
        query: { runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      position: 0,
      total: 0,
    });
  });

  it("returns 404 for a run owned by another user", async () => {
    const fixture = await track(
      store.set(seedQueuePositionRuns$, { queuedRuns: 1 }, context.signal),
    );
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);
    const runId = fixture.queuedRunIds[0];
    if (!runId) {
      throw new Error("Expected queued run fixture");
    }

    const client = setupApp({ context })(zeroQueuePositionContract);

    const response = await accept(
      client.getPosition({
        query: { runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 for a run from a different org", async () => {
    const fixture = await track(
      store.set(seedQueuePositionRuns$, { queuedRuns: 1 }, context.signal),
    );
    mocks.clerk.session(fixture.userId, `org_${randomUUID()}`);
    const runId = fixture.queuedRunIds[0];
    if (!runId) {
      throw new Error("Expected queued run fixture");
    }

    const client = setupApp({ context })(zeroQueuePositionContract);

    const response = await accept(
      client.getPosition({
        query: { runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when an authenticated user requests an unknown run", async () => {
    const fixture = await track(
      store.set(seedQueuePositionRuns$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroQueuePositionContract);

    const response = await accept(
      client.getPosition({
        query: { runId: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
