import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import type { StoredExecutionContext } from "@vm0/api-contracts/contracts/runners";
import { webhookCompleteContract } from "@vm0/api-contracts/contracts/webhooks";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { conversations } from "@vm0/db/schema/conversation";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { verifyHmacSignature } from "../../../lib/event-consumer/hmac";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  encryptQueuedRunnerJobPayload,
  queuedRunnerJobPayload,
} from "../../services/agent-run-queue-payload.service";
import { clearAllDetached } from "../../utils";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const TEST_CALLBACK_SECRET = "test-callback-secret";

interface CompleteWebhookFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly runId: string;
}

interface CheckpointFixture {
  readonly checkpointId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly artifactVersion: string;
  readonly volumeVersion: string;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function sandboxToken(fixture: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): string {
  const nowSeconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    runId: fixture.runId,
    userId: fixture.userId,
    orgId: fixture.orgId,
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
}

function authHeaders(fixture: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): { readonly authorization: string } {
  return { authorization: `Bearer ${sandboxToken(fixture)}` };
}

function completeClient() {
  return setupApp({ context })(webhookCompleteContract);
}

async function seedFixture(
  status = "running",
): Promise<CompleteWebhookFixture> {
  const base = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  const { composeId } = await store.set(
    seedCompose$,
    { orgId: base.orgId, userId: base.userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    { orgId: base.orgId, userId: base.userId, composeId, status },
    context.signal,
  );
  return { ...base, composeId, runId };
}

async function seedCheckpoint(
  fixture: CompleteWebhookFixture,
): Promise<CheckpointFixture> {
  const db = store.set(writeDb$);
  const [run] = await db
    .select({ sessionId: agentRuns.sessionId })
    .from(agentRuns)
    .where(eq(agentRuns.id, fixture.runId))
    .limit(1);
  if (!run) {
    throw new Error("seedCheckpoint: run not found");
  }

  const historyHash = "a".repeat(64);
  const [conversation] = await db
    .insert(conversations)
    .values({
      runId: fixture.runId,
      cliAgentType: "codex",
      cliAgentSessionId: `cli-${fixture.runId}`,
      cliAgentSessionHistoryHash: historyHash,
    })
    .returning({ id: conversations.id });
  if (!conversation) {
    throw new Error("seedCheckpoint: conversation insert returned no row");
  }

  await db
    .update(agentSessions)
    .set({ conversationId: conversation.id })
    .where(eq(agentSessions.id, run.sessionId));

  const artifactVersion = `artifact-${randomUUID()}`;
  const volumeVersion = `volume-${randomUUID()}`;
  const [checkpoint] = await db
    .insert(checkpoints)
    .values({
      runId: fixture.runId,
      conversationId: conversation.id,
      agentComposeSnapshot: {
        agentComposeVersionId: fixture.composeId,
      },
      artifactSnapshots: [
        {
          name: "workspace",
          version: artifactVersion,
          mountPath: "/workspace",
        },
      ],
      volumeVersionsSnapshot: {
        versions: {
          cache: volumeVersion,
        },
      },
    })
    .returning({ id: checkpoints.id });
  if (!checkpoint) {
    throw new Error("seedCheckpoint: checkpoint insert returned no row");
  }

  return {
    checkpointId: checkpoint.id,
    conversationId: conversation.id,
    sessionId: run.sessionId,
    artifactVersion,
    volumeVersion,
  };
}

async function runById(runId: string) {
  const db = store.set(writeDb$);
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return run;
}

const track = createFixtureTracker<CompleteWebhookFixture>(async (fixture) => {
  const db = store.set(writeDb$);
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

describe("POST /api/webhooks/agent/complete", () => {
  it("rejects missing sandbox auth", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      completeClient().complete({
        body: { runId: fixture.runId, exitCode: 0 },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated or runId mismatch",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("rejects a body runId that does not match the sandbox token", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      completeClient().complete({
        body: { runId: randomUUID(), exitCode: 0 },
        headers: authHeaders(fixture),
      }),
      [401],
    );

    expect(response.body.error.message).toBe(
      "Not authenticated or runId mismatch",
    );
  });

  it("rejects missing runId", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      completeClient().complete({
        body: { exitCode: 0 } as never,
        headers: authHeaders(fixture),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("runId");
  });

  it("rejects missing exitCode", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      completeClient().complete({
        body: { runId: fixture.runId } as never,
        headers: authHeaders(fixture),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("exitCode");
  });

  it("rejects negative lastEventSequence", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      completeClient().complete({
        body: { runId: fixture.runId, exitCode: 0, lastEventSequence: -1 },
        headers: authHeaders(fixture),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("lastEventSequence");
  });

  it("rejects lastEventSequence outside the database integer range", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      completeClient().complete({
        body: {
          runId: fixture.runId,
          exitCode: 0,
          lastEventSequence: 2_147_483_648,
        },
        headers: authHeaders(fixture),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("lastEventSequence");
  });

  it("rejects an invalid sandboxReuseResult value", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      completeClient().complete({
        body: {
          runId: fixture.runId,
          exitCode: 1,
          sandboxReuseResult: "someInvalidValue",
        } as never,
        headers: authHeaders(fixture),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("sandboxReuseResult");
  });

  it("returns not found for a missing run", async () => {
    const fixture = await track(seedFixture());
    const missingRunId = randomUUID();

    const response = await accept(
      completeClient().complete({
        body: { runId: missingRunId, exitCode: 0 },
        headers: {
          authorization: `Bearer ${sandboxToken({
            runId: missingRunId,
            userId: fixture.userId,
            orgId: fixture.orgId,
          })}`,
        },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Agent run not found",
        code: "NOT_FOUND",
      },
    });
  });

  it("returns not found when the sandbox user does not own the run", async () => {
    const fixture = await track(seedFixture());
    const otherFixture = await track(seedFixture());

    const response = await accept(
      completeClient().complete({
        body: { runId: otherFixture.runId, exitCode: 0 },
        headers: {
          authorization: `Bearer ${sandboxToken({
            runId: otherFixture.runId,
            userId: fixture.userId,
            orgId: fixture.orgId,
          })}`,
        },
      }),
      [404],
    );

    expect(response.body.error.message).toBe("Agent run not found");
  });

  it("completes a successful run from its checkpoint", async () => {
    const fixture = await track(seedFixture());
    const checkpoint = await seedCheckpoint(fixture);

    const response = await accept(
      completeClient().complete({
        body: {
          runId: fixture.runId,
          exitCode: 0,
          lastEventSequence: 7,
          sandboxId: "sandbox-success",
          sandboxReuseResult: "reused",
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      status: "completed",
    });

    const run = await runById(fixture.runId);
    expect(run).toMatchObject({
      status: "completed",
      lastEventSequence: 7,
      sandboxId: "sandbox-success",
      sandboxReuseResult: "reused",
      error: null,
    });
    expect(run?.completedAt).toBeInstanceOf(Date);
    expect(run?.result).toStrictEqual({
      checkpointId: checkpoint.checkpointId,
      agentSessionId: checkpoint.sessionId,
      conversationId: checkpoint.conversationId,
      artifact: {
        workspace: checkpoint.artifactVersion,
      },
      volumes: {
        cache: checkpoint.volumeVersion,
      },
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `run:changed:${fixture.runId}`,
      { status: "completed" },
    );
  });

  it("upgrades a timed-out run to completed when the checkpoint exists", async () => {
    const fixture = await track(seedFixture("timeout"));
    await seedCheckpoint(fixture);

    const response = await accept(
      completeClient().complete({
        body: { runId: fixture.runId, exitCode: 0 },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      status: "completed",
    });

    const run = await runById(fixture.runId);
    expect(run?.status).toBe("completed");
    expect(run?.error).toBeNull();
  });

  it("fails a successful completion when the checkpoint is missing", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      completeClient().complete({
        body: { runId: fixture.runId, exitCode: 0 },
        headers: authHeaders(fixture),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Checkpoint for run not found",
        code: "NOT_FOUND",
      },
    });

    const run = await runById(fixture.runId);
    expect(run).toMatchObject({
      status: "failed",
      error: "Checkpoint for run not found",
      lastEventSequence: null,
    });
  });

  it("persists lastEventSequence when the checkpoint is missing", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      completeClient().complete({
        body: { runId: fixture.runId, exitCode: 0, lastEventSequence: 4 },
        headers: authHeaders(fixture),
      }),
      [404],
    );

    expect(response.body.error.message).toBe("Checkpoint for run not found");
    const run = await runById(fixture.runId);
    expect(run).toMatchObject({
      status: "failed",
      lastEventSequence: 4,
    });
  });

  it("records runner failure output and device limiter mismatch reuse outcome", async () => {
    const fixture = await track(seedFixture("timeout"));

    const response = await accept(
      completeClient().complete({
        body: {
          runId: fixture.runId,
          exitCode: 1,
          error: "codex exited with status 1",
          sandboxId: "sandbox-failure",
          sandboxReuseResult: "deviceLimitMismatch",
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      status: "failed",
    });

    const run = await runById(fixture.runId);
    expect(run).toMatchObject({
      status: "failed",
      error: "codex exited with status 1",
      sandboxId: "sandbox-failure",
      sandboxReuseResult: "deviceLimitMismatch",
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `run:changed:${fixture.runId}`,
      { status: "failed" },
    );
  });

  it("returns idempotent success for duplicate terminal completions", async () => {
    const fixture = await track(seedFixture("completed"));

    const response = await accept(
      completeClient().complete({
        body: { runId: fixture.runId, exitCode: 1, lastEventSequence: 12 },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      status: "completed",
    });

    const run = await runById(fixture.runId);
    expect(run?.status).toBe("completed");
    expect(run?.lastEventSequence).toBe(12);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns idempotent success for duplicate failed completions", async () => {
    const fixture = await track(seedFixture("failed"));

    const response = await accept(
      completeClient().complete({
        body: { runId: fixture.runId, exitCode: 1, lastEventSequence: 12 },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      status: "failed",
    });

    const run = await runById(fixture.runId);
    expect(run?.status).toBe("failed");
    expect(run?.lastEventSequence).toBe(12);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("does not lower an existing lastEventSequence on duplicate completion", async () => {
    const fixture = await track(seedFixture("completed"));

    await accept(
      completeClient().complete({
        body: { runId: fixture.runId, exitCode: 0, lastEventSequence: 7 },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    const response = await accept(
      completeClient().complete({
        body: { runId: fixture.runId, exitCode: 0, lastEventSequence: 3 },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.status).toBe("completed");
    const run = await runById(fixture.runId);
    expect(run?.lastEventSequence).toBe(7);
  });

  it("returns failed when completion loses the transition race to cancellation", async () => {
    const fixture = await track(seedFixture());
    await seedCheckpoint(fixture);
    const db = store.set(writeDb$);
    await db
      .update(agentRuns)
      .set({ status: "cancelled", completedAt: nowDate() })
      .where(eq(agentRuns.id, fixture.runId));

    const response = await accept(
      completeClient().complete({
        body: { runId: fixture.runId, exitCode: 0 },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      status: "failed",
    });
    const run = await runById(fixture.runId);
    expect(run?.status).toBe("cancelled");
  });

  it("dispatches callbacks, drains the queue, and settles usage after completion", async () => {
    const fixture = await track(seedFixture());
    await seedCheckpoint(fixture);
    const callbackUrl = "https://callback.example/complete";
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      { runId: fixture.runId, url: callbackUrl, payload: { channel: "C1" } },
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

    const { runId: queuedRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "queued",
      },
      context.signal,
    );
    const db = store.set(writeDb$);
    const runnerGroup = `runner-group-${randomUUID()}`;
    const profile = "vm0/default";
    const queuedSessionId = `session-${randomUUID()}`;
    const queuedExecutionContext = {
      workingDir: "/workspace",
      storageManifest: null,
      environment: null,
      resumeSession: null,
      encryptedSecrets: null,
      cliAgentType: "codex",
    } satisfies StoredExecutionContext;
    await db.insert(agentRunQueue).values({
      runId: queuedRunId,
      orgId: fixture.orgId,
      userId: fixture.userId,
      encryptedParams: await encryptQueuedRunnerJobPayload(
        queuedRunnerJobPayload({
          runnerGroup,
          profile,
          sessionId: queuedSessionId,
          executionContext: queuedExecutionContext,
        }),
      ),
      expiresAt: new Date(now() + 60_000),
    });

    const provider = `test-provider-${randomUUID()}`;
    await db.insert(orgMetadata).values({
      orgId: fixture.orgId,
      credits: 1000,
      tier: "free",
    });
    await db.insert(usagePricing).values({
      kind: "model",
      provider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1000,
    });
    await db.insert(usageEvent).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      runId: fixture.runId,
      kind: "model",
      provider,
      category: "tokens.input",
      quantity: 5000,
      status: "pending",
      idempotencyKey: randomUUID(),
    });

    await accept(
      completeClient().complete({
        body: { runId: fixture.runId, exitCode: 0 },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    await clearAllDetached();

    expect(callbackBody).toStrictEqual({
      callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { channel: "C1" },
    });
    const [callback] = await db
      .select({
        status: agentRunCallbacks.status,
        attempts: agentRunCallbacks.attempts,
        deliveredAt: agentRunCallbacks.deliveredAt,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.id, callbackId))
      .limit(1);
    expect(callback?.status).toBe("delivered");
    expect(callback?.attempts).toBe(1);
    expect(callback?.deliveredAt).toBeInstanceOf(Date);

    const queuedRun = await runById(queuedRunId);
    expect(queuedRun?.status).toBe("pending");
    expect(queuedRun?.runnerGroup).toBe(runnerGroup);
    const [runnerJob] = await db
      .select({
        runId: runnerJobQueue.runId,
        runnerGroup: runnerJobQueue.runnerGroup,
        profile: runnerJobQueue.profile,
        sessionId: runnerJobQueue.sessionId,
        executionContext: runnerJobQueue.executionContext,
      })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, queuedRunId))
      .limit(1);
    expect(runnerJob).toStrictEqual({
      runId: queuedRunId,
      runnerGroup,
      profile,
      sessionId: queuedSessionId,
      executionContext: queuedExecutionContext,
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "queue:changed",
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("job", {
      runId: queuedRunId,
      profile,
    });

    const [eventRow] = await db
      .select({
        status: usageEvent.status,
        creditsCharged: usageEvent.creditsCharged,
      })
      .from(usageEvent)
      .where(eq(usageEvent.runId, fixture.runId));
    expect(eventRow).toStrictEqual({
      status: "processed",
      creditsCharged: 5,
    });

    const [orgRow] = await db
      .select({ credits: orgMetadata.credits })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    expect(orgRow?.credits).toBe(995);

    await db
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, provider),
          eq(usagePricing.category, "tokens.input"),
        ),
      );
  });
});
