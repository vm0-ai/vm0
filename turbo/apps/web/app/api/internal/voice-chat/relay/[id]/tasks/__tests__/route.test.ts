import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { signRelayToken } from "@vm0/core/voice-chat/relay-token";
import { reloadEnv } from "../../../../../../../../src/env";
import { testContext } from "../../../../../../../../src/__tests__/test-helpers";
import { createTestRequest } from "../../../../../../../../src/__tests__/api-test-helpers";
import { findTestZeroRun } from "../../../../../../../../src/__tests__/db-test-assertions/runs";
import { insertTestVoiceChatSession } from "../../../../../../../../src/__tests__/db-test-seeders/voice-chat";
import {
  seedVoiceChatAgent,
  seedVoiceChatSession,
  setupVoiceChatOrg,
} from "../../../../../../zero/voice-chat/__tests__/_helpers";

const SECRET = "00".repeat(32); // 64 hex chars — A3's verify expects hex secret
const BASE_URL = "http://localhost:3000/api/internal/voice-chat/relay";

vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { POST } = await import("../route");

const context = testContext();

interface SeededFixture {
  userId: string;
  orgId: string;
  agentId: string | null;
  sessionId: string;
}

async function seedFixtureWithAgent(): Promise<SeededFixture> {
  const { userId } = await context.setupUser();
  const { orgId } = await setupVoiceChatOrg(userId);
  const { agentId } = await seedVoiceChatAgent(userId, orgId);
  const session = await seedVoiceChatSession({ orgId, userId, agentId });
  return { userId, orgId, agentId, sessionId: session.id };
}

async function seedFixtureWithoutAgent(): Promise<SeededFixture> {
  const { userId } = await context.setupUser();
  const { orgId } = await setupVoiceChatOrg(userId);
  const sessionId = await insertTestVoiceChatSession({
    orgId,
    userId,
    agentId: null,
  });
  return { userId, orgId, agentId: null, sessionId };
}

function tokenFor(
  fixture: SeededFixture,
  override?: { voiceChatSessionId?: string; expired?: boolean },
): string {
  const result = signRelayToken(
    {
      voiceChatSessionId: override?.voiceChatSessionId ?? fixture.sessionId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      ttlSeconds: override?.expired === true ? -1 : 3600,
    },
    SECRET,
  );
  return result.token;
}

function postRequest(opts: {
  sessionId: string;
  body: unknown;
  token?: string;
}) {
  return createTestRequest(`${BASE_URL}/${opts.sessionId}/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify(opts.body),
  });
}

function paramsFor(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/internal/voice-chat/relay/:id/tasks", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("VOICE_CHAT_RELAY_TOKEN_SECRET", SECRET);
    reloadEnv();
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const fixture = await seedFixtureWithAgent();
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: { prompt: "do a thing", callId: randomUUID() },
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(401);
  });

  it("returns 401 when the relay token signature is invalid", async () => {
    const fixture = await seedFixtureWithAgent();
    const goodToken = tokenFor(fixture);
    const [payload] = goodToken.split(".");
    const tampered = `${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: { prompt: "do a thing", callId: randomUUID() },
        token: tampered,
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(401);
  });

  it("returns 503 when the relay-token secret is not configured", async () => {
    vi.stubEnv("VOICE_CHAT_RELAY_TOKEN_SECRET", "");
    reloadEnv();
    const fixture = await seedFixtureWithAgent();
    const token = tokenFor(fixture);
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: { prompt: "do a thing", callId: randomUUID() },
        token,
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(503);
  });

  it("returns 400 with code NO_AGENT when the session has no agent", async () => {
    const fixture = await seedFixtureWithoutAgent();
    const token = tokenFor(fixture);
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: { prompt: "do a thing", callId: randomUUID() },
        token,
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { message: string; code: string };
    };
    expect(body.error.code).toBe("NO_AGENT");
  });

  it("returns 400 when prompt is missing", async () => {
    const fixture = await seedFixtureWithAgent();
    const token = tokenFor(fixture);
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: { callId: randomUUID() },
        token,
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when callId is missing", async () => {
    const fixture = await seedFixtureWithAgent();
    const token = tokenFor(fixture);
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: { prompt: "do a thing" },
        token,
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(400);
  });

  it("creates a task and dispatches a zero run with triggerSource=voice-chat", async () => {
    const fixture = await seedFixtureWithAgent();
    const token = tokenFor(fixture);
    const callId = randomUUID();
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: { prompt: "summarize latest", callId },
        token,
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      task: {
        sessionId: string;
        callId: string;
        prompt: string;
        status: string;
        runId: string;
      };
    };
    expect(body.task.sessionId).toBe(fixture.sessionId);
    expect(body.task.callId).toBe(callId);
    expect(body.task.prompt).toBe("summarize latest");
    expect(["pending", "queued"]).toContain(body.task.status);
    expect(body.task.runId).toBeTruthy();

    const zeroRun = await findTestZeroRun(body.task.runId);
    expect(zeroRun?.triggerSource).toBe("voice-chat");
  });
});
