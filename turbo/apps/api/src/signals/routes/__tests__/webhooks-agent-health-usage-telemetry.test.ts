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

async function postRawUsageEvent(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const app = createApp({ signal: context.signal });
  const response = await app.request("/api/webhooks/agent/usage-event", {
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

async function postRawTelemetry(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const app = createApp({ signal: context.signal });
  const response = await app.request("/api/webhooks/agent/telemetry", {
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

  interface UsageEventItem {
    readonly idempotencyKey: string;
    readonly kind: "connector" | "model" | "image";
    readonly provider: string;
    readonly category: string;
    readonly quantity: number;
  }

  function validUsageEvent(): UsageEventItem {
    return {
      idempotencyKey: randomUUID(),
      kind: "connector" as const,
      provider: "x",
      category: "tweet.read",
      quantity: 5,
    };
  }

  function validBody(
    fixture: AgentWebhookFixture,
    event: UsageEventItem = validUsageEvent(),
  ) {
    return {
      runId: fixture.runId,
      events: [event],
    };
  }

  function rawBody(
    fixture: AgentWebhookFixture,
    event: Record<string, unknown>,
  ) {
    return {
      runId: fixture.runId,
      events: [event],
    };
  }

  async function rowsForRun(runId: string) {
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
        status: usageEvent.status,
      })
      .from(usageEvent)
      .where(eq(usageEvent.runId, runId));

    return [...rows].sort((left, right) => {
      return left.idempotencyKey.localeCompare(right.idempotencyKey);
    });
  }

  it("rejects missing sandbox auth", async () => {
    const fixture = await track(seedFixture());
    const client = setupApp({ context })(webhookUsageEventContract);

    const response = await accept(
      client.send({ body: validBody(fixture), headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated or runId mismatch",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("rejects sandbox auth for a different run", async () => {
    const fixture = await track(seedFixture());
    const client = setupApp({ context })(webhookUsageEventContract);

    const response = await accept(
      client.send({
        body: validBody(fixture),
        headers: {
          authorization: `Bearer ${sandboxToken({
            ...fixture,
            runId: randomUUID(),
          })}`,
        },
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

  it("rejects missing runId before inserting usage events", async () => {
    const fixture = await track(seedFixture());

    const response = await postRawUsageEvent(
      { events: [validUsageEvent()] },
      authHeaders(fixture),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(JSON.stringify(response.body)).toContain("runId");
    await expect(rowsForRun(fixture.runId)).resolves.toStrictEqual([]);
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

    await expect(rowsForRun(fixture.runId)).resolves.toStrictEqual([
      {
        runId: fixture.runId,
        orgId: fixture.orgId,
        userId: fixture.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 42,
        idempotencyKey,
        status: "pending",
      },
    ]);
  });

  it("keeps the first value when a retry reuses an idempotency key", async () => {
    const fixture = await track(seedFixture());
    const sharedKey = randomUUID();
    const client = setupApp({ context })(webhookUsageEventContract);

    await accept(
      client.send({
        body: validBody(fixture, {
          ...validUsageEvent(),
          idempotencyKey: sharedKey,
          quantity: 5,
        }),
        headers: authHeaders(fixture),
      }),
      [200],
    );
    await accept(
      client.send({
        body: validBody(fixture, {
          ...validUsageEvent(),
          idempotencyKey: sharedKey,
          quantity: 99,
        }),
        headers: authHeaders(fixture),
      }),
      [200],
    );

    await expect(rowsForRun(fixture.runId)).resolves.toMatchObject([
      {
        idempotencyKey: sharedKey,
        quantity: 5,
      },
    ]);
  });

  it("writes separate rows for different categories", async () => {
    const fixture = await track(seedFixture());
    const client = setupApp({ context })(webhookUsageEventContract);

    await accept(
      client.send({
        body: validBody(fixture, {
          ...validUsageEvent(),
          category: "tweet.read",
          quantity: 3,
        }),
        headers: authHeaders(fixture),
      }),
      [200],
    );
    await accept(
      client.send({
        body: validBody(fixture, {
          ...validUsageEvent(),
          category: "users.read",
          quantity: 2,
        }),
        headers: authHeaders(fixture),
      }),
      [200],
    );

    const byCategory = Object.fromEntries(
      (await rowsForRun(fixture.runId)).map((row) => {
        return [row.category, row.quantity];
      }),
    );
    expect(byCategory).toStrictEqual({
      "tweet.read": 3,
      "users.read": 2,
    });
  });

  it("accepts quantity zero", async () => {
    const fixture = await track(seedFixture());
    const client = setupApp({ context })(webhookUsageEventContract);

    const response = await accept(
      client.send({
        body: validBody(fixture, { ...validUsageEvent(), quantity: 0 }),
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });
    await expect(rowsForRun(fixture.runId)).resolves.toMatchObject([
      { quantity: 0 },
    ]);
  });

  it("accepts a batch with model and image usage events", async () => {
    const fixture = await track(seedFixture());
    const modelEventId = randomUUID();
    const imageEventId = randomUUID();
    const client = setupApp({ context })(webhookUsageEventContract);

    const response = await accept(
      client.send({
        body: {
          runId: fixture.runId,
          events: [
            {
              idempotencyKey: modelEventId,
              kind: "model",
              provider: "claude-sonnet-4-6",
              category: "tokens.input",
              quantity: 123,
            },
            {
              idempotencyKey: imageEventId,
              kind: "image",
              provider: "gpt-image-1",
              category: "output_image",
              quantity: 1,
            },
          ],
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });
    await expect(rowsForRun(fixture.runId)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: modelEventId,
          kind: "model",
          provider: "claude-sonnet-4-6",
          category: "tokens.input",
          quantity: 123,
          status: "pending",
        }),
        expect.objectContaining({
          idempotencyKey: imageEventId,
          kind: "image",
          provider: "gpt-image-1",
          category: "output_image",
          quantity: 1,
          status: "pending",
        }),
      ]),
    );
  });

  it("deduplicates duplicate idempotency keys inside a batch", async () => {
    const fixture = await track(seedFixture());
    const sharedKey = randomUUID();
    const client = setupApp({ context })(webhookUsageEventContract);

    await accept(
      client.send({
        body: {
          runId: fixture.runId,
          events: [
            {
              idempotencyKey: sharedKey,
              kind: "connector",
              provider: "x",
              category: "tweet.read",
              quantity: 3,
            },
            {
              idempotencyKey: sharedKey,
              kind: "connector",
              provider: "x",
              category: "users.read",
              quantity: 7,
            },
          ],
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    await expect(rowsForRun(fixture.runId)).resolves.toMatchObject([
      {
        idempotencyKey: sharedKey,
        provider: "x",
        category: "tweet.read",
        quantity: 3,
      },
    ]);
  });

  it("deduplicates a retried batch by idempotency key", async () => {
    const fixture = await track(seedFixture());
    const firstEventId = randomUUID();
    const secondEventId = randomUUID();
    const client = setupApp({ context })(webhookUsageEventContract);
    const request = {
      body: {
        runId: fixture.runId,
        events: [
          {
            idempotencyKey: firstEventId,
            kind: "model" as const,
            provider: "claude-sonnet-4-6",
            category: "tokens.input",
            quantity: 10,
          },
          {
            idempotencyKey: secondEventId,
            kind: "model" as const,
            provider: "claude-sonnet-4-6",
            category: "tokens.output",
            quantity: 20,
          },
        ],
      },
      headers: authHeaders(fixture),
    };

    await accept(client.send(request), [200]);
    await accept(client.send(request), [200]);

    const rows = await rowsForRun(fixture.runId);
    expect(rows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: firstEventId,
          category: "tokens.input",
          quantity: 10,
        }),
        expect.objectContaining({
          idempotencyKey: secondEventId,
          category: "tokens.output",
          quantity: 20,
        }),
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("accepts batches at the 100-event limit", async () => {
    const fixture = await track(seedFixture());
    const firstEventId = randomUUID();
    const lastEventId = randomUUID();
    const client = setupApp({ context })(webhookUsageEventContract);

    await accept(
      client.send({
        body: {
          runId: fixture.runId,
          events: Array.from({ length: 100 }, (_, index) => {
            return {
              idempotencyKey:
                index === 0
                  ? firstEventId
                  : index === 99
                    ? lastEventId
                    : randomUUID(),
              kind: "model" as const,
              provider: "claude-sonnet-4-6",
              category: index % 2 === 0 ? "tokens.input" : "tokens.output",
              quantity: index + 1,
            };
          }),
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    const rows = await rowsForRun(fixture.runId);
    expect(rows).toHaveLength(100);
    expect(rows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ idempotencyKey: firstEventId, quantity: 1 }),
        expect.objectContaining({ idempotencyKey: lastEventId, quantity: 100 }),
      ]),
    );
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

  it.each([
    {
      name: "negative quantity",
      body: (fixture: AgentWebhookFixture) => {
        return rawBody(fixture, { ...validUsageEvent(), quantity: -1 });
      },
    },
    {
      name: "non-integer quantity",
      body: (fixture: AgentWebhookFixture) => {
        return rawBody(fixture, { ...validUsageEvent(), quantity: 1.5 });
      },
    },
    {
      name: "unknown kind",
      body: (fixture: AgentWebhookFixture) => {
        return rawBody(fixture, {
          ...validUsageEvent(),
          kind: "external-api",
        });
      },
    },
    {
      name: "unexpected event field",
      body: (fixture: AgentWebhookFixture) => {
        return rawBody(fixture, { ...validUsageEvent(), unexpected: true });
      },
    },
    {
      name: "unexpected top-level field",
      body: (fixture: AgentWebhookFixture) => {
        return { ...validBody(fixture), unexpected: true };
      },
    },
    {
      name: "empty provider",
      body: (fixture: AgentWebhookFixture) => {
        return rawBody(fixture, { ...validUsageEvent(), provider: "" });
      },
    },
    {
      name: "empty category",
      body: (fixture: AgentWebhookFixture) => {
        return rawBody(fixture, { ...validUsageEvent(), category: "" });
      },
    },
    {
      name: "non-UUID idempotencyKey",
      body: (fixture: AgentWebhookFixture) => {
        return rawBody(fixture, {
          ...validUsageEvent(),
          idempotencyKey: "not-a-uuid",
        });
      },
    },
    {
      name: "empty batch",
      body: (fixture: AgentWebhookFixture) => {
        return { runId: fixture.runId, events: [] };
      },
    },
    {
      name: "legacy single-event body",
      body: (fixture: AgentWebhookFixture) => {
        return {
          runId: fixture.runId,
          ...validUsageEvent(),
        };
      },
    },
    {
      name: "batch with more than 100 events",
      body: (fixture: AgentWebhookFixture) => {
        return {
          runId: fixture.runId,
          events: Array.from({ length: 101 }, (_, index) => {
            return {
              idempotencyKey: randomUUID(),
              kind: "model",
              provider: "claude-sonnet-4-6",
              category: index % 2 === 0 ? "tokens.input" : "tokens.output",
              quantity: index,
            };
          }),
        };
      },
    },
  ])("rejects $name", async ({ body }) => {
    const fixture = await track(seedFixture());

    const response = await postRawUsageEvent(
      body(fixture),
      authHeaders(fixture),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    await expect(rowsForRun(fixture.runId)).resolves.toStrictEqual([]);
  });
});

describe("POST /api/webhooks/agent/telemetry", () => {
  const track = createFixtureTracker<AgentWebhookFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("rejects missing sandbox auth", async () => {
    const client = setupApp({ context })(webhookTelemetryContract);

    const response = await accept(
      client.send({
        body: { runId: randomUUID(), systemLog: "boot ok" },
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
    expect(context.mocks.axiom.ingest).not.toHaveBeenCalled();
    expect(context.mocks.axiom.flush).not.toHaveBeenCalled();
  });

  it("rejects missing runId before ingesting telemetry", async () => {
    const fixture = await track(seedFixture());

    const response = await postRawTelemetry(
      { systemLog: "boot ok" },
      authHeaders(fixture),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(JSON.stringify(response.body)).toContain("runId");
    expect(context.mocks.axiom.ingest).not.toHaveBeenCalled();
    expect(context.mocks.axiom.flush).not.toHaveBeenCalled();
  });

  it("returns 404 when the authenticated run no longer exists", async () => {
    const missingRun = {
      runId: randomUUID(),
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    const client = setupApp({ context })(webhookTelemetryContract);

    const response = await accept(
      client.send({
        body: { runId: missingRun.runId, systemLog: "boot ok" },
        headers: authHeaders(missingRun),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
    expect(context.mocks.axiom.ingest).not.toHaveBeenCalled();
    expect(context.mocks.axiom.flush).not.toHaveBeenCalled();
  });

  it("returns 404 for a run owned by a different user", async () => {
    const fixture = await track(seedFixture());
    const client = setupApp({ context })(webhookTelemetryContract);

    const response = await accept(
      client.send({
        body: { runId: fixture.runId, systemLog: "boot ok" },
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
    expect(context.mocks.axiom.ingest).not.toHaveBeenCalled();
    expect(context.mocks.axiom.flush).not.toHaveBeenCalled();
  });

  it("ingests sandbox telemetry and flushes uploaded telemetry", async () => {
    const fixture = await track(seedFixture());
    const client = setupApp({ context })(webhookTelemetryContract);
    context.mocks.axiom.sdkIngest.mockReset();

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
    expect(context.mocks.axiom.sdkIngest).toHaveBeenCalledWith(
      "vm0-sandbox-op-log-dev",
      [
        expect.objectContaining({
          source: "sandbox",
          op_type: "codex_exec",
          sandbox_type: "runner",
          duration_ms: 123,
          success: false,
          run_id: fixture.runId,
          error: "exit 1",
        }),
      ],
    );
  });

  it("accepts multiple telemetry uploads for the same run", async () => {
    const fixture = await track(seedFixture());
    const client = setupApp({ context })(webhookTelemetryContract);
    const headers = { authorization: `Bearer ${sandboxToken(fixture)}` };

    const firstResponse = await accept(
      client.send({
        body: { runId: fixture.runId, systemLog: "First batch" },
        headers,
      }),
      [200],
    );
    const secondResponse = await accept(
      client.send({
        body: { runId: fixture.runId, systemLog: "Second batch" },
        headers,
      }),
      [200],
    );

    expect(firstResponse.body).toStrictEqual({
      success: true,
      id: fixture.runId,
    });
    expect(secondResponse.body).toStrictEqual({
      success: true,
      id: fixture.runId,
    });
    expect(context.mocks.axiom.ingest).toHaveBeenCalledTimes(2);
    expect(context.mocks.axiom.ingest).toHaveBeenNthCalledWith(
      1,
      "sandbox-telemetry-system",
      [
        expect.objectContaining({
          runId: fixture.runId,
          userId: fixture.userId,
          log: "First batch",
        }),
      ],
    );
    expect(context.mocks.axiom.ingest).toHaveBeenNthCalledWith(
      2,
      "sandbox-telemetry-system",
      [
        expect.objectContaining({
          runId: fixture.runId,
          userId: fixture.userId,
          log: "Second batch",
        }),
      ],
    );
    expect(context.mocks.axiom.flush).toHaveBeenCalledTimes(2);
    expect(context.mocks.axiom.flush).toHaveBeenNthCalledWith(1, {
      client: "telemetry",
      throwOnError: true,
    });
    expect(context.mocks.axiom.flush).toHaveBeenNthCalledWith(2, {
      client: "telemetry",
      throwOnError: true,
    });
  });
});
