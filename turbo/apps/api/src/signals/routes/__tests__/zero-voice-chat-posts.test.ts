import { randomUUID } from "node:crypto";

import {
  zeroVoiceChatContract,
  type AppendVoiceChatItemBody,
  type VoiceChatTokenBody,
} from "@vm0/api-contracts/contracts/zero-voice-chat";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { voiceChatTasks } from "@vm0/db/schema/voice-chat";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  addVoiceChatSession$,
  deleteVoiceChatFixture$,
  seedVoiceChatAgent$,
  seedVoiceChatFixture$,
  seedVoiceChatRealtimePricing$,
  type VoiceChatFixture,
} from "./helpers/zero-voice-chat";

const context = testContext();
const store = createStore();
const writeDb = store.set(writeDb$);
const mocks = createZeroRouteMocks(context);
const OPENAI_REALTIME_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/client_secrets";
const VOICE_CHAT_CALLBACK_URL =
  "http://localhost:3000/api/internal/callbacks/voice-chat";

const track = createFixtureTracker<VoiceChatFixture>((fixture) => {
  return store.set(deleteVoiceChatFixture$, fixture, context.signal);
});

function client() {
  return setupApp({ context })(zeroVoiceChatContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function proxyVoiceChatCallbackToApp(): void {
  server.use(
    http.post(VOICE_CHAT_CALLBACK_URL, async ({ request }) => {
      const app = createApp({ signal: context.signal });
      return await app.request("/api/internal/callbacks/voice-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await request.text(),
      });
    }),
  );
}

async function rawCreateSessionWithoutBody(): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const app = createApp({ signal: context.signal });
  const response = await app.request("/api/zero/voice-chat", {
    method: "POST",
    headers: { authorization: "Bearer clerk-session" },
  });

  return { status: response.status, body: await response.json() };
}

async function rawTokenWithoutBody(): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const app = createApp({ signal: context.signal });
  const response = await app.request("/api/zero/voice-chat/token", {
    method: "POST",
    headers: { authorization: "Bearer clerk-session" },
  });

  return { status: response.status, body: await response.json() };
}

async function seedEnabledFixture(
  options: {
    readonly credits?: number;
    readonly realtimeBillingEnabled?: boolean;
  } = {},
): Promise<{ fixture: VoiceChatFixture; agentId: string }> {
  const fixture = await track(
    store.set(
      seedVoiceChatFixture$,
      {
        trinityEnabled: true,
        realtimeBillingEnabled: options.realtimeBillingEnabled,
        credits: options.credits,
      },
      context.signal,
    ),
  );
  const agentId = await store.set(
    seedVoiceChatAgent$,
    fixture,
    {},
    context.signal,
  );
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return { fixture, agentId };
}

interface OpenAiRealtimeSessionPayload {
  readonly type?: string;
  readonly model?: string;
  readonly reasoning?: unknown;
  readonly output_modalities?: unknown;
  readonly instructions?: string;
  readonly audio?: {
    readonly input?: {
      readonly transcription?: unknown;
      readonly noise_reduction?: unknown;
      readonly turn_detection?: unknown;
    };
    readonly output?: {
      readonly voice?: string;
    };
  };
  readonly tools?: readonly { readonly name?: string }[];
}

interface OpenAiClientSecretRequest {
  readonly session?: OpenAiRealtimeSessionPayload;
}

function expectDefaultOpenAiSessionPayload(
  session: OpenAiRealtimeSessionPayload | undefined,
): void {
  if (!session) {
    throw new Error("OpenAI session payload was not captured");
  }
  expect(session.type).toBe("realtime");
  expect(session.model).toBe("gpt-realtime-2");
  expect(session.reasoning).toStrictEqual({ effort: "low" });
  expect(session.output_modalities).toStrictEqual(["audio"]);
  expect(typeof session.instructions).toBe("string");
  expect(session.instructions).toContain("## Preambles");
  expect(session.instructions).toContain("## Unclear Audio");
  expect(session.audio?.input?.transcription).toStrictEqual({
    model: "gpt-4o-mini-transcribe",
  });
  expect(session.audio?.input?.noise_reduction).toStrictEqual({
    type: "far_field",
  });
  expect(session.audio?.input?.turn_detection).toStrictEqual({
    type: "semantic_vad",
    eagerness: "medium",
    interrupt_response: false,
  });
  expect(session.audio?.output?.voice).toBe("verse");
  const toolNames = session.tools?.map((tool) => {
    return tool.name;
  });
  expect(toolNames).toContain("inform_slow_brain");
  expect(toolNames).toContain("feel_confused");
}

describe("POST /api/zero/voice-chat (createSession)", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      client().createSession({
        headers: {},
        body: { agentId: randomUUID() },
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when Trinity is disabled", async () => {
    const fixture = await track(
      store.set(seedVoiceChatFixture$, {}, context.signal),
    );
    const agentId = await store.set(
      seedVoiceChatAgent$,
      fixture,
      {},
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().createSession({
        headers: authHeaders(),
        body: { agentId },
      }),
      [403],
    );
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 when agentId is not a uuid", async () => {
    await seedEnabledFixture();

    const response = await accept(
      client().createSession({
        headers: authHeaders(),
        body: { agentId: "not-a-uuid" } as never,
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when the body is missing", async () => {
    await seedEnabledFixture();

    const response = await rawCreateSessionWithoutBody();
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("creates or resumes the caller's latest session for the agent", async () => {
    const { fixture, agentId } = await seedEnabledFixture();

    const created = await accept(
      client().createSession({
        headers: authHeaders(),
        body: { agentId },
      }),
      [200],
    );
    expect(created.body.session.orgId).toBe(fixture.orgId);
    expect(created.body.session.userId).toBe(fixture.userId);
    expect(created.body.session.agentId).toBe(agentId);
    expect(created.body.session.mode).toBe("chat");
    expect(created.body.talkerInstructions).toContain("## Preambles");

    const resumed = await accept(
      client().createSession({
        headers: authHeaders(),
        body: { agentId },
      }),
      [200],
    );
    expect(resumed.body.session.id).toBe(created.body.session.id);
  });
});

describe("POST /api/zero/voice-chat/:id/items (appendItem)", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      client().appendItem({
        headers: {},
        params: { id: randomUUID() },
        body: {
          role: "user",
          content: "hello",
          realtimeItemId: `item_${randomUUID()}`,
        },
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when Trinity is disabled", async () => {
    const fixture = await track(
      store.set(seedVoiceChatFixture$, {}, context.signal),
    );
    const agentId = await store.set(
      seedVoiceChatAgent$,
      fixture,
      {},
      context.signal,
    );
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().appendItem({
        headers: authHeaders(),
        params: { id: sessionId },
        body: {
          role: "user",
          content: "hello",
          realtimeItemId: `item_${randomUUID()}`,
        },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the session does not exist", async () => {
    await seedEnabledFixture();

    const response = await accept(
      client().appendItem({
        headers: authHeaders(),
        params: { id: randomUUID() },
        body: {
          role: "user",
          content: "hello",
          realtimeItemId: `item_${randomUUID()}`,
        },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 when the role is invalid", async () => {
    const { fixture, agentId } = await seedEnabledFixture();
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );

    const response = await accept(
      client().appendItem({
        headers: authHeaders(),
        params: { id: sessionId },
        body: {
          role: "invalid",
          content: "hello",
          realtimeItemId: `item_${randomUUID()}`,
        } as unknown as AppendVoiceChatItemBody,
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when the body is missing", async () => {
    const { fixture, agentId } = await seedEnabledFixture();
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );

    const response = await accept(
      client().appendItem({
        headers: authHeaders(),
        params: { id: sessionId },
        body: undefined as unknown as AppendVoiceChatItemBody,
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("appends an item and silently dedupes duplicate realtimeItemId", async () => {
    const { agentId } = await seedEnabledFixture();
    const created = await accept(
      client().createSession({
        headers: authHeaders(),
        body: { agentId },
      }),
      [200],
    );
    const realtimeItemId = `item_${randomUUID()}`;

    const first = await accept(
      client().appendItem({
        headers: authHeaders(),
        params: { id: created.body.session.id },
        body: {
          role: "user",
          content: "hello",
          realtimeItemId,
        },
      }),
      [200],
    );
    expect(first.body.item.sessionId).toBe(created.body.session.id);
    expect(first.body.item.role).toBe("user");
    expect(first.body.item.content).toBe("hello");
    expect(first.body.item.realtimeItemId).toBe(realtimeItemId);
    expect(first.body.item.seq).toBeGreaterThanOrEqual(1);

    const second = await accept(
      client().appendItem({
        headers: authHeaders(),
        params: { id: created.body.session.id },
        body: {
          role: "user",
          content: "retry body should not win",
          realtimeItemId,
        },
      }),
      [200],
    );
    expect(second.body.item.id).toBe(first.body.item.id);
    expect(second.body.item.content).toBe("hello");
  });

  it("returns 404 for a session owned by another user", async () => {
    const { fixture, agentId } = await seedEnabledFixture();
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);

    const response = await accept(
      client().appendItem({
        headers: authHeaders(),
        params: { id: sessionId },
        body: {
          role: "user",
          content: "hello",
          realtimeItemId: `item_${randomUUID()}`,
        },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

describe("POST /api/zero/voice-chat/:id/tasks (createTask)", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      client().createTask({
        headers: {},
        params: { id: randomUUID() },
        body: { prompt: "do it", callId: "call-unauthenticated" },
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when Trinity is disabled", async () => {
    const fixture = await track(
      store.set(seedVoiceChatFixture$, { sessions: [{}] }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const sessionId = fixture.sessionIds[0]!;

    const response = await accept(
      client().createTask({
        headers: authHeaders(),
        params: { id: sessionId },
        body: { prompt: "do it", callId: "call-disabled" },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the session is missing", async () => {
    await seedEnabledFixture();

    const response = await accept(
      client().createTask({
        headers: authHeaders(),
        params: { id: randomUUID() },
        body: { prompt: "do it", callId: "call-missing" },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the session belongs to a different user", async () => {
    const otherUserId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedVoiceChatFixture$,
        {
          trinityEnabled: true,
          sessions: [{ userId: otherUserId }],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const otherSessionId = fixture.sessionIds[0]!;

    const response = await accept(
      client().createTask({
        headers: authHeaders(),
        params: { id: otherSessionId },
        body: { prompt: "do it", callId: "call-other-user" },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the session belongs to a different org", async () => {
    const otherOrgId = `org_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedVoiceChatFixture$,
        {
          trinityEnabled: true,
          sessions: [{ orgId: otherOrgId }],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const otherSessionId = fixture.sessionIds[0]!;

    const response = await accept(
      client().createTask({
        headers: authHeaders(),
        params: { id: otherSessionId },
        body: { prompt: "do it", callId: "call-other-org" },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 when prompt is missing", async () => {
    const { fixture, agentId } = await seedEnabledFixture();
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );

    const response = await accept(
      client().createTask({
        headers: authHeaders(),
        params: { id: sessionId },
        body: { callId: "call-missing-prompt" } as never,
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when callId is missing", async () => {
    const { fixture, agentId } = await seedEnabledFixture();
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );

    const response = await accept(
      client().createTask({
        headers: authHeaders(),
        params: { id: sessionId },
        body: { prompt: "do it" } as never,
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("creates a task, zero run, and voice-chat callback", async () => {
    proxyVoiceChatCallbackToApp();

    const { fixture, agentId } = await seedEnabledFixture();
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );

    const response = await accept(
      client().createTask({
        headers: authHeaders(),
        params: { id: sessionId },
        body: { prompt: "summarize latest deploy", callId: "call-1" },
      }),
      [200],
    );
    expect(response.body.task.sessionId).toBe(sessionId);
    expect(response.body.task.callId).toBe("call-1");
    expect(response.body.task.prompt).toBe("summarize latest deploy");
    expect(response.body.task.runId).toBeTruthy();
    expect(response.body.task.status).toBe("pending");

    const [zeroRun] = await writeDb
      .select({ triggerSource: zeroRuns.triggerSource })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, response.body.task.runId!))
      .limit(1);
    expect(zeroRun?.triggerSource).toBe("voice-chat");

    const [callback] = await writeDb
      .select({
        url: agentRunCallbacks.url,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, response.body.task.runId!))
      .limit(1);
    expect(callback?.url).toContain("/api/internal/callbacks/voice-chat");
    expect(callback?.payload).toStrictEqual({ taskId: response.body.task.id });
  });

  it("returns 400 when the session has no agent", async () => {
    const { fixture } = await seedEnabledFixture();
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId: null },
      context.signal,
    );

    const response = await accept(
      client().createTask({
        headers: authHeaders(),
        params: { id: sessionId },
        body: { prompt: "do it", callId: "call-2" },
      }),
      [400],
    );
    expect(response.body.error.message).toBe(
      "Session has no agent; cannot spawn task",
    );
  });

  it("returns provider admission errors declared by the contract", async () => {
    const { fixture } = await seedEnabledFixture();
    const agentId = await store.set(
      seedVoiceChatAgent$,
      fixture,
      { environment: {} },
      context.signal,
    );
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );

    const response = await accept(
      client().createTask({
        headers: authHeaders(),
        params: { id: sessionId },
        body: { prompt: "do it", callId: "call-3" },
      }),
      [503],
    );
    expect(response.body.error.code).toBe("PROVIDER_UNAVAILABLE");

    const rows = await writeDb
      .select({ id: voiceChatTasks.id })
      .from(voiceChatTasks)
      .where(eq(voiceChatTasks.sessionId, sessionId));
    expect(rows).toStrictEqual([]);
  });
});

describe("POST /api/zero/voice-chat/:id/trigger-reasoning", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      client().triggerReasoning({
        headers: {},
        params: { id: randomUUID() },
        body: {},
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when Trinity is disabled", async () => {
    const fixture = await track(
      store.set(seedVoiceChatFixture$, {}, context.signal),
    );
    const agentId = await store.set(
      seedVoiceChatAgent$,
      fixture,
      {},
      context.signal,
    );
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().triggerReasoning({
        headers: authHeaders(),
        params: { id: sessionId },
        body: {},
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the session does not exist", async () => {
    await seedEnabledFixture();

    const response = await accept(
      client().triggerReasoning({
        headers: authHeaders(),
        params: { id: randomUUID() },
        body: {},
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 for a session owned by another user or org", async () => {
    const { fixture, agentId } = await seedEnabledFixture();
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );
    await seedEnabledFixture();

    const response = await accept(
      client().triggerReasoning({
        headers: authHeaders(),
        params: { id: sessionId },
        body: {},
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("queues a reasoner tick for an owned session", async () => {
    const { fixture, agentId } = await seedEnabledFixture();
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );

    const response = await accept(
      client().triggerReasoning({
        headers: authHeaders(),
        params: { id: sessionId },
        body: {},
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ ok: true });
  });
});

describe("POST /api/zero/voice-chat/token", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      client().token({
        headers: {},
        body: { sessionId: randomUUID() },
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when Trinity is disabled", async () => {
    const fixture = await track(
      store.set(seedVoiceChatFixture$, {}, context.signal),
    );
    const agentId = await store.set(
      seedVoiceChatAgent$,
      fixture,
      {},
      context.signal,
    );
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().token({
        headers: authHeaders(),
        body: { sessionId },
      }),
      [403],
    );
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 when the body is missing", async () => {
    await seedEnabledFixture();

    const response = await rawTokenWithoutBody();
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("returns 400 when sessionId is not a uuid", async () => {
    await seedEnabledFixture();

    const response = await accept(
      client().token({
        headers: authHeaders(),
        body: { sessionId: "not-a-uuid" } as unknown as VoiceChatTokenBody,
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when noiseReduction is invalid", async () => {
    await seedEnabledFixture();

    const response = await accept(
      client().token({
        headers: authHeaders(),
        body: {
          sessionId: randomUUID(),
          noiseReduction: "invalid",
        } as unknown as VoiceChatTokenBody,
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 when the session does not exist", async () => {
    await seedEnabledFixture();

    const response = await accept(
      client().token({
        headers: authHeaders(),
        body: { sessionId: randomUUID() },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the session belongs to a different user or org", async () => {
    const { fixture, agentId } = await seedEnabledFixture();
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );
    await seedEnabledFixture();

    const response = await accept(
      client().token({
        headers: authHeaders(),
        body: { sessionId },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("mints an OpenAI realtime client secret with default talker instructions", async () => {
    mockEnv("OPENAI_API_KEY", "test-openai-key");
    const { fixture, agentId } = await seedEnabledFixture();
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );

    let upstreamBody: OpenAiClientSecretRequest | undefined;
    let safetyIdentifier: string | null = null;
    server.use(
      http.post(OPENAI_REALTIME_CLIENT_SECRETS_URL, async ({ request }) => {
        upstreamBody = (await request.json()) as OpenAiClientSecretRequest;
        safetyIdentifier = request.headers.get("OpenAI-Safety-Identifier");
        return HttpResponse.json({
          value: "ek_test",
          expires_at: 999_999,
        });
      }),
    );

    const response = await accept(
      client().token({
        headers: authHeaders(),
        body: { sessionId },
      }),
      [200],
    );
    expect(response.body.client_secret.value).toBe("ek_test");
    expect(safetyIdentifier).toHaveLength(64);
    expect(safetyIdentifier).not.toBe(fixture.userId);
    expectDefaultOpenAiSessionPayload(upstreamBody?.session);
  });

  it("threads near_field noiseReduction through to the upstream body", async () => {
    mockEnv("OPENAI_API_KEY", "test-openai-key");
    const { fixture, agentId } = await seedEnabledFixture();
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );

    let upstreamBody: OpenAiClientSecretRequest | undefined;
    server.use(
      http.post(OPENAI_REALTIME_CLIENT_SECRETS_URL, async ({ request }) => {
        upstreamBody = (await request.json()) as OpenAiClientSecretRequest;
        return HttpResponse.json({
          value: "ek_test",
          expires_at: 999_999,
        });
      }),
    );

    const response = await accept(
      client().token({
        headers: authHeaders(),
        body: { sessionId, noiseReduction: "near_field" },
      }),
      [200],
    );
    expect(response.body.client_secret.value).toBe("ek_test");
    expect(upstreamBody?.session?.audio?.input?.noise_reduction).toStrictEqual({
      type: "near_field",
    });
  });

  it("returns 500 when OpenAI returns an error", async () => {
    mockEnv("OPENAI_API_KEY", "test-openai-key");
    const { fixture, agentId } = await seedEnabledFixture();
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );
    server.use(
      http.post(OPENAI_REALTIME_CLIENT_SECRETS_URL, () => {
        return HttpResponse.json(
          { error: { message: "bad" } },
          { status: 400 },
        );
      }),
    );

    const response = await accept(
      client().token({
        headers: authHeaders(),
        body: { sessionId },
      }),
      [500],
    );
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("returns 402 before minting when realtime billing is enabled without credits", async () => {
    const { fixture, agentId } = await seedEnabledFixture({
      credits: 0,
      realtimeBillingEnabled: true,
    });
    await store.set(seedVoiceChatRealtimePricing$, context.signal);
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );

    const response = await accept(
      client().token({
        headers: authHeaders(),
        body: { sessionId },
      }),
      [402],
    );
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("mints after realtime billing credit and pricing admission passes", async () => {
    mockEnv("OPENAI_API_KEY", "test-openai-key");
    const { fixture, agentId } = await seedEnabledFixture({
      credits: 1000,
      realtimeBillingEnabled: true,
    });
    await store.set(seedVoiceChatRealtimePricing$, context.signal);
    const sessionId = await store.set(
      addVoiceChatSession$,
      fixture,
      { agentId },
      context.signal,
    );
    server.use(
      http.post(OPENAI_REALTIME_CLIENT_SECRETS_URL, () => {
        return HttpResponse.json({
          value: "ek_admitted",
          expires_at: 999_999,
        });
      }),
    );

    const response = await accept(
      client().token({
        headers: authHeaders(),
        body: { sessionId },
      }),
      [200],
    );
    expect(response.body.client_secret.value).toBe("ek_admitted");
  });
});
