import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { webhookEventsContract } from "@vm0/api-contracts/contracts/webhooks";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { usageEvent } from "@vm0/db/schema/usage-event";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  addRunToThread$,
  deleteZeroChatThread$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import { seedRun$ } from "./helpers/zero-usage-insight";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();

interface AgentEventsFixture extends ZeroChatThreadFixture {
  readonly runId: string;
}

const trackChatFixture = createFixtureTracker<ZeroChatThreadFixture>(
  (fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  },
);

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

function webhookClient() {
  return setupApp({ context })(webhookEventsContract);
}

async function postRawWebhook(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const app = createApp({ signal: context.signal });
  const response = await app.request("/api/webhooks/agent/events", {
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

async function forwardToApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = await request.text();
  const app = createApp({ signal: context.signal });
  const response = await app.request(url.pathname, {
    method: request.method,
    headers: request.headers,
    body,
  });

  return new HttpResponse(response.body, {
    status: response.status,
    headers: response.headers,
  });
}

function routeInternalConsumers(): void {
  server.use(
    http.post(
      "http://api.test/api/internal/event-consumers/:consumer",
      ({ request }) => {
        return forwardToApi(request);
      },
    ),
  );
}

async function seedFixture(): Promise<AgentEventsFixture> {
  const fixture = await trackChatFixture(
    store.set(seedZeroChatThread$, {}, context.signal),
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId: fixture.composeId,
      status: "running",
    },
    context.signal,
  );
  await store.set(
    addRunToThread$,
    { threadId: fixture.threadId, runId },
    context.signal,
  );
  return { ...fixture, runId };
}

function readAssistantMessages(runId: string): Promise<
  readonly {
    readonly content: string | null;
    readonly sequenceNumber: number | null;
    readonly runEventId: string | null;
  }[]
> {
  const writeDb = store.set(writeDb$);
  return writeDb
    .select({
      content: chatMessages.content,
      sequenceNumber: chatMessages.sequenceNumber,
      runEventId: chatMessages.runEventId,
    })
    .from(chatMessages)
    .where(
      and(eq(chatMessages.runId, runId), eq(chatMessages.role, "assistant")),
    );
}

function readUsageEvents(runId: string): Promise<
  readonly {
    readonly id: string;
  }[]
> {
  const writeDb = store.set(writeDb$);
  return writeDb
    .select({ id: usageEvent.id })
    .from(usageEvent)
    .where(eq(usageEvent.runId, runId));
}

beforeEach(() => {
  mockEnv("VM0_API_URL", "http://api.test");
  mockOptionalEnv("AGENTPHONE_API_BASE_URL", "https://api.agentphone.to");
  mockOptionalEnv("AGENTPHONE_API_KEY", "agentphone-test-key");
  routeInternalConsumers();
});

describe("POST /api/webhooks/agent/events", () => {
  it("rejects missing sandbox auth", async () => {
    const response = await accept(
      webhookClient().send({
        body: {
          runId: randomUUID(),
          events: [{ type: "assistant", sequenceNumber: 1 }],
        },
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

  it("rejects invalid sandbox tokens", async () => {
    const fixture = await seedFixture();
    const response = await accept(
      webhookClient().send({
        body: {
          runId: fixture.runId,
          events: [{ type: "assistant", sequenceNumber: 1 }],
        },
        headers: { authorization: "Bearer invalid-token-not-jwt" },
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

  it("rejects missing runId before dispatch", async () => {
    const fixture = await seedFixture();
    const response = await postRawWebhook(
      {
        events: [{ type: "assistant", sequenceNumber: 1 }],
      },
      authHeaders(fixture),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(JSON.stringify(response.body)).toContain("runId");
    expect(context.mocks.axiom.ingest).not.toHaveBeenCalled();
  });

  it("rejects missing events before dispatch", async () => {
    const fixture = await seedFixture();
    const response = await postRawWebhook(
      {
        runId: fixture.runId,
      },
      authHeaders(fixture),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(JSON.stringify(response.body)).toContain("events");
    expect(context.mocks.axiom.ingest).not.toHaveBeenCalled();
  });

  it("rejects invalid event payloads before dispatch", async () => {
    const fixture = await seedFixture();
    const response = await accept(
      webhookClient().send({
        body: { runId: fixture.runId, events: [] },
        headers: authHeaders(fixture),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("events");
    expect(context.mocks.axiom.ingest).not.toHaveBeenCalled();
  });

  it("rejects negative event sequence numbers before dispatch", async () => {
    const fixture = await seedFixture();
    const response = await postRawWebhook(
      {
        runId: fixture.runId,
        events: [{ type: "assistant", sequenceNumber: -1 }],
      },
      authHeaders(fixture),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(JSON.stringify(response.body)).toContain("sequenceNumber");
    expect(context.mocks.axiom.ingest).not.toHaveBeenCalled();
  });

  it("rejects event sequence numbers outside the database integer range", async () => {
    const fixture = await seedFixture();
    const response = await postRawWebhook(
      {
        runId: fixture.runId,
        events: [{ type: "assistant", sequenceNumber: 2_147_483_648 }],
      },
      authHeaders(fixture),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(JSON.stringify(response.body)).toContain("sequenceNumber");
    expect(context.mocks.axiom.ingest).not.toHaveBeenCalled();
  });

  it("returns 404 when the authenticated run does not exist", async () => {
    const missing = {
      runId: randomUUID(),
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };

    const response = await accept(
      webhookClient().send({
        body: {
          runId: missing.runId,
          events: [{ type: "assistant", sequenceNumber: 1 }],
        },
        headers: authHeaders(missing),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 when the sandbox user does not own the run", async () => {
    const fixture = await seedFixture();
    const otherFixture = await trackChatFixture(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const { runId: otherRunId } = await store.set(
      seedRun$,
      {
        orgId: otherFixture.orgId,
        userId: otherFixture.userId,
        composeId: otherFixture.composeId,
        status: "running",
      },
      context.signal,
    );

    const response = await accept(
      webhookClient().send({
        body: {
          runId: otherRunId,
          events: [{ type: "assistant", sequenceNumber: 1 }],
        },
        headers: authHeaders({
          runId: otherRunId,
          userId: fixture.userId,
          orgId: fixture.orgId,
        }),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });

  it("dispatches valid events to required and optional consumers", async () => {
    const fixture = await seedFixture();

    const response = await accept(
      webhookClient().send({
        body: {
          runId: fixture.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: 7,
              message: {
                id: "msg_7",
                content: [{ type: "text", text: "Hello from API events" }],
              },
            },
            {
              type: "tool_result",
              sequenceNumber: 8,
              result: "ok",
            },
          ],
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      received: 2,
      firstSequence: 7,
      lastSequence: 8,
    });
    expect(context.mocks.axiom.ingest).toHaveBeenCalledWith(
      "agent-run-events",
      expect.arrayContaining([
        expect.objectContaining({
          runId: fixture.runId,
          userId: fixture.userId,
          sequenceNumber: 7,
          eventType: "assistant",
        }),
        expect.objectContaining({
          runId: fixture.runId,
          userId: fixture.userId,
          sequenceNumber: 8,
          eventType: "tool_result",
        }),
      ]),
    );
    await expect(readAssistantMessages(fixture.runId)).resolves.toStrictEqual([
      {
        content: "Hello from API events",
        sequenceNumber: 7,
        runEventId: "msg_7",
      },
    ]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `run:changed:${fixture.runId}`,
      { firstSequence: 7, lastSequence: 8 },
    );
  });

  it("handles a batch of events while preserving event data", async () => {
    const fixture = await seedFixture();
    const events = Array.from({ length: 15 }, (_, index) => {
      return {
        type: `event_${index}`,
        sequenceNumber: index,
        timestamp: 1_234_567_890 + index,
        data: { index, message: `Event number ${index}` },
      };
    });

    const response = await accept(
      webhookClient().send({
        body: { runId: fixture.runId, events },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      received: 15,
      firstSequence: 0,
      lastSequence: 14,
    });
    expect(context.mocks.axiom.ingest).toHaveBeenCalledWith(
      "agent-run-events",
      expect.arrayContaining(
        events.map((event) => {
          return expect.objectContaining({
            runId: fixture.runId,
            userId: fixture.userId,
            sequenceNumber: event.sequenceNumber,
            eventType: event.type,
            eventData: event,
          });
        }),
      ),
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `run:changed:${fixture.runId}`,
      { firstSequence: 0, lastSequence: 14 },
    );
  });

  it("does not dispatch optional consumers when required Axiom dispatch fails", async () => {
    const fixture = await seedFixture();
    context.mocks.axiom.ingest.mockReturnValue(false);
    let chatAssistantCalls = 0;
    server.use(
      http.post(
        "http://api.test/api/internal/event-consumers/chat-assistant",
        () => {
          chatAssistantCalls++;
          return HttpResponse.json({ processed: 1 });
        },
      ),
    );

    const response = await accept(
      webhookClient().send({
        body: {
          runId: fixture.runId,
          events: [{ type: "assistant", sequenceNumber: 1 }],
        },
        headers: authHeaders(fixture),
      }),
      [500],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Required event consumer dispatch failed: axiom",
        code: "INTERNAL_SERVER_ERROR",
      },
    });
    expect(chatAssistantCalls).toBe(0);
  });

  it("rejects events when Axiom flush fails", async () => {
    const fixture = await seedFixture();
    context.mocks.axiom.flush.mockRejectedValueOnce(new Error("flush failed"));

    const response = await accept(
      webhookClient().send({
        body: {
          runId: fixture.runId,
          events: [{ type: "assistant", sequenceNumber: 1 }],
        },
        headers: authHeaders(fixture),
      }),
      [500],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Required event consumer dispatch failed: axiom",
        code: "INTERNAL_SERVER_ERROR",
      },
    });
  });

  it("accepts events when an optional consumer fails", async () => {
    const fixture = await seedFixture();
    server.use(
      http.post(
        "http://api.test/api/internal/event-consumers/chat-assistant",
        () => {
          return HttpResponse.json(
            { error: "chat assistant unavailable" },
            { status: 503 },
          );
        },
      ),
    );

    const response = await accept(
      webhookClient().send({
        body: {
          runId: fixture.runId,
          events: [{ type: "assistant", sequenceNumber: 1 }],
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      received: 1,
      firstSequence: 1,
      lastSequence: 1,
    });
    expect(context.mocks.axiom.ingest).toHaveBeenCalledWith(
      "agent-run-events",
      [
        expect.objectContaining({
          runId: fixture.runId,
          sequenceNumber: 1,
          eventType: "assistant",
        }),
      ],
    );
  });

  it("does not dispatch typing refresh consumers for agent events", async () => {
    const fixture = await seedFixture();
    const typingConsumerCalls: string[] = [];
    server.use(
      http.post(
        "http://api.test/api/internal/event-consumers/telegram-typing",
        () => {
          typingConsumerCalls.push("telegram-typing");
          return HttpResponse.json({ scheduled: true });
        },
      ),
      http.post(
        "http://api.test/api/internal/event-consumers/agentphone-typing",
        () => {
          typingConsumerCalls.push("agentphone-typing");
          return HttpResponse.json({ scheduled: true });
        },
      ),
    );

    await accept(
      webhookClient().send({
        body: {
          runId: fixture.runId,
          events: [
            { type: "assistant", sequenceNumber: 1 },
            { type: "item.completed", sequenceNumber: 2 },
            { type: "tool_result", sequenceNumber: 3 },
          ],
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(typingConsumerCalls).toStrictEqual([]);
  });

  it("does not write usage_event rows for result events", async () => {
    const fixture = await seedFixture();

    const response = await accept(
      webhookClient().send({
        body: {
          runId: fixture.runId,
          events: [
            {
              type: "result",
              uuid: randomUUID(),
              sequenceNumber: 1,
              timestamp: 1_234_567_890,
              usage: {
                input_tokens: 100,
                output_tokens: 50,
              },
            },
          ],
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      received: 1,
      firstSequence: 1,
      lastSequence: 1,
    });
    await expect(readUsageEvents(fixture.runId)).resolves.toStrictEqual([]);
  });
});
