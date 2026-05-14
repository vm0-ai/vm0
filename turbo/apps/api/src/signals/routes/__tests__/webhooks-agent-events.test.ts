import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { webhookEventsContract } from "@vm0/api-contracts/contracts/webhooks";
import { chatMessages } from "@vm0/db/schema/chat-message";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { clearAllDetached } from "../../utils";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
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

  it("dispatches AgentPhone typing refresh through the API consumer", async () => {
    const fixture = await seedFixture();
    await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        url: "http://localhost/api/internal/callbacks/agentphone",
        payload: {
          conversationId: "conv-agentphone-api-events",
          channel: "imessage",
        },
      },
      context.signal,
    );

    const typingCalls: string[] = [];
    server.use(
      http.post(
        "https://api.agentphone.to/v1/conversations/:conversationId/typing",
        ({ params }) => {
          typingCalls.push(String(params.conversationId));
          return HttpResponse.json({ scheduled: true });
        },
      ),
    );

    await accept(
      webhookClient().send({
        body: {
          runId: fixture.runId,
          events: [{ type: "tool_result", sequenceNumber: 1 }],
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );
    await clearAllDetached();

    expect(typingCalls).toStrictEqual(["conv-agentphone-api-events"]);
  });
});
