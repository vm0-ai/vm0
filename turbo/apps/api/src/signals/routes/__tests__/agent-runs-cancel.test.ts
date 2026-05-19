import { randomUUID } from "node:crypto";

import { runsCancelContract } from "@vm0/api-contracts/contracts/runs";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { verifyHmacSignature } from "../../../lib/event-consumer/hmac";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now, nowDate } from "../../external/time";
import { clearAllDetached } from "../../utils";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const TEST_CALLBACK_SECRET = "test-callback-secret";

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

function cancelClient() {
  return setupApp({ context })(runsCancelContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    iat: seconds,
    exp: seconds + 60,
  });
}

async function fixture(): Promise<{
  readonly fixture: UsageInsightFixture;
  readonly composeId: string;
}> {
  const fx = await track(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  const compose = await store.set(
    seedCompose$,
    { orgId: fx.orgId, userId: fx.userId },
    context.signal,
  );
  mocks.clerk.session(fx.userId, fx.orgId);
  return { fixture: fx, composeId: compose.composeId };
}

async function createRun(args: {
  readonly fixture: UsageInsightFixture;
  readonly composeId: string;
  readonly status: string;
}): Promise<string> {
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: args.fixture.orgId,
      userId: args.fixture.userId,
      composeId: args.composeId,
      status: args.status,
    },
    context.signal,
  );
  return runId;
}

describe("POST /api/agent/runs/:id/cancel", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      cancelClient().cancel({
        params: { id: randomUUID() },
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when the run does not exist", async () => {
    await fixture();

    const response = await accept(
      cancelClient().cancel({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("cancels a running run and publishes side effects", async () => {
    const fx = await fixture();
    const runId = await createRun({
      fixture: fx.fixture,
      composeId: fx.composeId,
      status: "running",
    });

    const response = await accept(
      cancelClient().cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: runId,
      status: "cancelled",
      message: "Run cancelled successfully",
    });

    const db = store.set(writeDb$);
    const [run] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(run?.status).toBe("cancelled");

    await clearAllDetached();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "queue:changed",
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `runChanged:${runId}`,
      { status: "cancelled" },
    );
  });

  it("cancels a queued run and removes its queue entry", async () => {
    const fx = await fixture();
    const runId = await createRun({
      fixture: fx.fixture,
      composeId: fx.composeId,
      status: "queued",
    });
    const db = store.set(writeDb$);
    await db.insert(agentRunQueue).values({
      runId,
      orgId: fx.fixture.orgId,
      userId: fx.fixture.userId,
      createdAt: nowDate(),
      expiresAt: new Date(now() + 60_000),
    });

    await accept(
      cancelClient().cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const queueRows = await db
      .select()
      .from(agentRunQueue)
      .where(eq(agentRunQueue.runId, runId));
    expect(queueRows).toHaveLength(0);
  });

  it("drains the org queue after cancelling a running run", async () => {
    const fx = await fixture();
    const runningRunId = await createRun({
      fixture: fx.fixture,
      composeId: fx.composeId,
      status: "running",
    });
    const queuedRunId = await createRun({
      fixture: fx.fixture,
      composeId: fx.composeId,
      status: "queued",
    });
    const db = store.set(writeDb$);
    await db.insert(agentRunQueue).values({
      runId: queuedRunId,
      orgId: fx.fixture.orgId,
      userId: fx.fixture.userId,
      createdAt: nowDate(),
      expiresAt: new Date(now() + 60_000),
    });

    await accept(
      cancelClient().cancel({
        params: { id: runningRunId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await clearAllDetached();

    const queueRows = await db
      .select()
      .from(agentRunQueue)
      .where(eq(agentRunQueue.runId, queuedRunId));
    expect(queueRows).toHaveLength(0);
    const [queuedRun] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, queuedRunId));
    expect(queuedRun?.status).toBe("pending");
  });

  it("dispatches registered callbacks after cancelling a run", async () => {
    const fx = await fixture();
    const runId = await createRun({
      fixture: fx.fixture,
      composeId: fx.composeId,
      status: "running",
    });
    const callbackUrl = "https://callback.example/cancel";
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      { runId, url: callbackUrl, payload: { source: "cancel-test" } },
      context.signal,
    );
    let callbackBody: unknown;
    server.use(
      http.post(callbackUrl, async ({ request }) => {
        const rawBody = await request.text();
        const timestamp = Number(request.headers.get("x-vm0-timestamp"));
        const signature = request.headers.get("x-vm0-signature");
        expect(signature).not.toBeNull();
        expect(
          verifyHmacSignature(
            rawBody,
            TEST_CALLBACK_SECRET,
            timestamp,
            signature ?? "",
          ),
        ).toBeTruthy();
        callbackBody = JSON.parse(rawBody) as unknown;
        return HttpResponse.json({ ok: true });
      }),
    );

    await accept(
      cancelClient().cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await clearAllDetached();

    expect(callbackBody).toStrictEqual({
      callbackId,
      runId,
      status: "failed",
      error: "Run cancelled",
      payload: { source: "cancel-test" },
    });
    const db = store.set(writeDb$);
    const [callback] = await db
      .select({
        status: agentRunCallbacks.status,
        attempts: agentRunCallbacks.attempts,
        lastAttemptAt: agentRunCallbacks.lastAttemptAt,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.id, callbackId));
    expect(callback?.status).toBe("delivered");
    expect(callback?.attempts).toBe(1);
    expect(callback?.lastAttemptAt).toBeInstanceOf(Date);
  });

  it("returns 200 for an already-cancelled run without side effects", async () => {
    const fx = await fixture();
    const runId = await createRun({
      fixture: fx.fixture,
      composeId: fx.composeId,
      status: "cancelled",
    });

    const response = await accept(
      cancelClient().cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.status).toBe("cancelled");
    await clearAllDetached();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 400 RUN_NOT_CANCELLABLE for completed runs", async () => {
    const fx = await fixture();
    const runId = await createRun({
      fixture: fx.fixture,
      composeId: fx.composeId,
      status: "completed",
    });

    const response = await accept(
      cancelClient().cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("RUN_NOT_CANCELLABLE");
  });

  it("returns 404 for a run in another org", async () => {
    const owner = await fixture();
    const runId = await createRun({
      fixture: owner.fixture,
      composeId: owner.composeId,
      status: "running",
    });
    const other = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(other.userId, other.orgId);

    const response = await accept(
      cancelClient().cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("accepts a sandbox token with any capability", async () => {
    const fx = await fixture();
    const runId = await createRun({
      fixture: fx.fixture,
      composeId: fx.composeId,
      status: "running",
    });

    const response = await accept(
      cancelClient().cancel({
        params: { id: runId },
        headers: {
          authorization: `Bearer ${sandboxToken({
            userId: fx.fixture.userId,
            orgId: fx.fixture.orgId,
            runId,
          })}`,
        },
      }),
      [200],
    );

    expect(response.body.status).toBe("cancelled");
  });

  it("returns 404 when the sandbox token source run is missing", async () => {
    const fx = await fixture();
    const runId = await createRun({
      fixture: fx.fixture,
      composeId: fx.composeId,
      status: "running",
    });

    const response = await accept(
      cancelClient().cancel({
        params: { id: runId },
        headers: {
          authorization: `Bearer ${sandboxToken({
            userId: fx.fixture.userId,
            orgId: fx.fixture.orgId,
            runId: randomUUID(),
          })}`,
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
