import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { delay } from "signal-timers";
import { describe, expect, it } from "vitest";
import {
  webhookHeartbeatContract,
  webhookTelemetryContract,
  webhookUsageEventContract,
} from "@vm0/api-contracts/contracts/webhooks";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { server } from "../../../mocks/server";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { verifyHmacSignature } from "../../../lib/event-consumer/hmac";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { signSandboxJwtForTests } from "../../auth/tokens";
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

interface AgentWebhookFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly runId: string;
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

async function postRawHeartbeat(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const app = createApp({ signal: context.signal });
  const response = await app.request("/api/webhooks/agent/heartbeat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function seedFixture(status = "running"): Promise<AgentWebhookFixture> {
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
    {
      orgId: base.orgId,
      userId: base.userId,
      composeId,
      status,
    },
    context.signal,
  );
  return { ...base, composeId, runId };
}

async function heartbeatAt(runId: string): Promise<Date | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ lastHeartbeatAt: agentRuns.lastHeartbeatAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row?.lastHeartbeatAt ?? null;
}

function waitFor<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    delay(1000, { signal: context.signal }).then(() => {
      throw new Error("Timed out waiting for webhook side effect");
    }),
  ]);
}

describe("POST /api/webhooks/agent/heartbeat", () => {
  const track = createFixtureTracker<AgentWebhookFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("rejects missing sandbox auth", async () => {
    const client = setupApp({ context })(webhookHeartbeatContract);

    const response = await accept(
      client.send({ body: { runId: randomUUID() }, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated or runId mismatch",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("rejects missing runId before updating the run", async () => {
    const fixture = await track(seedFixture());

    const response = await postRawHeartbeat({}, authHeaders(fixture));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(JSON.stringify(response.body)).toContain("runId");
    await expect(heartbeatAt(fixture.runId)).resolves.toBeNull();
  });

  it("returns 404 when the authenticated run no longer exists", async () => {
    const missingRun = {
      runId: randomUUID(),
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    const client = setupApp({ context })(webhookHeartbeatContract);

    const response = await accept(
      client.send({
        body: { runId: missingRun.runId },
        headers: authHeaders(missingRun),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 for a run owned by a different user", async () => {
    const fixture = await track(seedFixture());
    const client = setupApp({ context })(webhookHeartbeatContract);

    const response = await accept(
      client.send({
        body: { runId: fixture.runId },
        headers: authHeaders({
          runId: fixture.runId,
          userId: `other_${randomUUID()}`,
          orgId: fixture.orgId,
        }),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });

  it("updates the run heartbeat and dispatches pending progress callbacks", async () => {
    const fixture = await track(seedFixture());
    const callbackUrl = "https://callback.example/progress";
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      { runId: fixture.runId, url: callbackUrl, payload: { channel: "C1" } },
      context.signal,
    );
    let callbackBody: unknown;
    const progressReceived = new Promise<void>((resolve) => {
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
          resolve();
          return HttpResponse.json({ ok: true });
        }),
      );
    });
    const client = setupApp({ context })(webhookHeartbeatContract);

    const response = await accept(
      client.send({
        body: { runId: fixture.runId },
        headers: { authorization: `Bearer ${sandboxToken(fixture)}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ ok: true });
    await expect(heartbeatAt(fixture.runId)).resolves.toBeInstanceOf(Date);
    await waitFor(progressReceived);
    expect(callbackBody).toStrictEqual({
      callbackId,
      runId: fixture.runId,
      status: "progress",
      payload: { channel: "C1" },
    });

    const db = store.set(writeDb$);
    const [callback] = await db
      .select({
        status: agentRunCallbacks.status,
        attempts: agentRunCallbacks.attempts,
        lastAttemptAt: agentRunCallbacks.lastAttemptAt,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.id, callbackId))
      .limit(1);
    expect(callback).toStrictEqual({
      status: "pending",
      attempts: 0,
      lastAttemptAt: null,
    });
  });

  it("accepts multiple consecutive heartbeats for the same run", async () => {
    const fixture = await track(seedFixture());
    const client = setupApp({ context })(webhookHeartbeatContract);
    const request = {
      body: { runId: fixture.runId },
      headers: authHeaders(fixture),
    };

    const firstResponse = await accept(client.send(request), [200]);
    const secondResponse = await accept(client.send(request), [200]);

    expect(firstResponse.body).toStrictEqual({ ok: true });
    expect(secondResponse.body).toStrictEqual({ ok: true });
    await expect(heartbeatAt(fixture.runId)).resolves.toBeInstanceOf(Date);
  });
});

describe("POST /api/webhooks/agent/usage-event", () => {
  const track = createFixtureTracker<AgentWebhookFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("persists usage events idempotently for the sandbox run", async () => {
    const fixture = await track(seedFixture());
    const idempotencyKey = randomUUID();
    const client = setupApp({ context })(webhookUsageEventContract);
    const request = {
      body: {
        runId: fixture.runId,
        events: [
          {
            idempotencyKey,
            kind: "model" as const,
            provider: "claude-sonnet-4-6",
            category: "tokens.input",
            quantity: 42,
          },
        ],
      },
      headers: { authorization: `Bearer ${sandboxToken(fixture)}` },
    };

    await accept(client.send(request), [200]);
    await accept(client.send(request), [200]);

    const db = store.set(writeDb$);
    const rows = await db
      .select({
        runId: usageEvent.runId,
        orgId: usageEvent.orgId,
        userId: usageEvent.userId,
        kind: usageEvent.kind,
        provider: usageEvent.provider,
        category: usageEvent.category,
        quantity: usageEvent.quantity,
        idempotencyKey: usageEvent.idempotencyKey,
      })
      .from(usageEvent)
      .where(eq(usageEvent.idempotencyKey, idempotencyKey));

    expect(rows).toStrictEqual([
      {
        runId: fixture.runId,
        orgId: fixture.orgId,
        userId: fixture.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 42,
        idempotencyKey,
      },
    ]);
  });

  it("returns 404 when the authenticated run no longer exists", async () => {
    const missingRun = {
      runId: randomUUID(),
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    const client = setupApp({ context })(webhookUsageEventContract);

    const response = await accept(
      client.send({
        body: {
          runId: missingRun.runId,
          events: [
            {
              idempotencyKey: randomUUID(),
              kind: "connector",
              provider: "github",
              category: "repo.read",
              quantity: 1,
            },
          ],
        },
        headers: { authorization: `Bearer ${sandboxToken(missingRun)}` },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Run not found", code: "NOT_FOUND" },
    });
  });
});

describe("POST /api/webhooks/agent/telemetry", () => {
  const track = createFixtureTracker<AgentWebhookFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("ingests sandbox telemetry and flushes network logs", async () => {
    const fixture = await track(seedFixture());
    const client = setupApp({ context })(webhookTelemetryContract);

    const response = await accept(
      client.send({
        body: {
          runId: fixture.runId,
          systemLog: "boot ok",
          metrics: [
            {
              ts: "2026-05-14T01:00:00.000Z",
              cpu: 10,
              mem_used: 100,
              mem_total: 200,
              disk_used: 300,
              disk_total: 400,
            },
          ],
          networkLogs: [
            {
              timestamp: "2026-05-14T01:00:01.000Z",
              action: "ALLOW",
              host: "api.example.com",
              port: 443,
            },
          ],
          sandboxOperations: [
            {
              ts: "2026-05-14T01:00:02.000Z",
              action_type: "codex_exec",
              duration_ms: 123,
              success: false,
              error: "exit 1",
            },
          ],
        },
        headers: { authorization: `Bearer ${sandboxToken(fixture)}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      id: fixture.runId,
    });
    expect(context.mocks.axiom.ingest).toHaveBeenCalledWith(
      "sandbox-telemetry-system",
      [
        expect.objectContaining({
          runId: fixture.runId,
          userId: fixture.userId,
          log: "boot ok",
        }),
      ],
    );
    expect(context.mocks.axiom.ingest).toHaveBeenCalledWith(
      "sandbox-telemetry-metrics",
      [
        {
          _time: "2026-05-14T01:00:00.000Z",
          runId: fixture.runId,
          userId: fixture.userId,
          cpu: 10,
          mem_used: 100,
          mem_total: 200,
          disk_used: 300,
          disk_total: 400,
        },
      ],
    );
    expect(context.mocks.axiom.ingest).toHaveBeenCalledWith(
      "sandbox-telemetry-network",
      [
        {
          _time: "2026-05-14T01:00:01.000Z",
          runId: fixture.runId,
          userId: fixture.userId,
          action: "ALLOW",
          host: "api.example.com",
          port: 443,
        },
      ],
    );
    expect(context.mocks.axiom.flush).toHaveBeenCalledWith({
      client: "telemetry",
      throwOnError: true,
    });
  });
});
