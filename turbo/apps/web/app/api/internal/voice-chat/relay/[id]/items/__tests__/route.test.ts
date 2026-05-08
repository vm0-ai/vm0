import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { signRelayToken } from "@vm0/core/voice-chat/relay-token";
import { reloadEnv } from "../../../../../../../../src/env";
import { testContext } from "../../../../../../../../src/__tests__/test-helpers";
import { createTestRequest } from "../../../../../../../../src/__tests__/api-test-helpers";
import { readTestVoiceChatItems } from "../../../../../../../../src/__tests__/db-test-assertions/voice-chat";
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

async function seedFixture(): Promise<SeededFixture> {
  const { userId } = await context.setupUser();
  const { orgId } = await setupVoiceChatOrg(userId);
  const { agentId } = await seedVoiceChatAgent(userId, orgId);
  const session = await seedVoiceChatSession({ orgId, userId, agentId });
  return { userId, orgId, agentId, sessionId: session.id };
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
  return createTestRequest(`${BASE_URL}/${opts.sessionId}/items`, {
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

describe("POST /api/internal/voice-chat/relay/:id/items", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("VOICE_CHAT_RELAY_TOKEN_SECRET", SECRET);
    reloadEnv();
  });

  it("returns 503 when the relay-token secret is not configured", async () => {
    vi.stubEnv("VOICE_CHAT_RELAY_TOKEN_SECRET", "");
    reloadEnv();
    const fixture = await seedFixture();
    const token = tokenFor(fixture);
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: { role: "user", content: "hi", realtimeItemId: randomUUID() },
        token,
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(503);
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const fixture = await seedFixture();
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: { role: "user", content: "hi", realtimeItemId: randomUUID() },
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(401);
  });

  it("returns 401 when the relay token signature is invalid", async () => {
    const fixture = await seedFixture();
    const goodToken = tokenFor(fixture);
    const [payload] = goodToken.split(".");
    const tampered = `${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: { role: "user", content: "hi", realtimeItemId: randomUUID() },
        token: tampered,
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(401);
  });

  it("returns 401 when the token's voiceChatSessionId doesn't match the path", async () => {
    const fixture = await seedFixture();
    const otherSessionId = randomUUID();
    const token = tokenFor(fixture, {
      voiceChatSessionId: otherSessionId,
    });
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: { role: "user", content: "hi", realtimeItemId: randomUUID() },
        token,
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(401);
  });

  it("returns 401 for an expired token", async () => {
    const fixture = await seedFixture();
    const token = tokenFor(fixture, { expired: true });
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: { role: "user", content: "hi", realtimeItemId: randomUUID() },
        token,
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(401);
  });

  it("returns 400 when the body is invalid", async () => {
    const fixture = await seedFixture();
    const token = tokenFor(fixture);
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: { role: "invalid", content: "hi", realtimeItemId: "rt_1" },
        token,
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(400);
  });

  it("inserts a user transcript item on first call and is idempotent on the second", async () => {
    const fixture = await seedFixture();
    const token = tokenFor(fixture);
    const realtimeItemId = randomUUID();
    const body = {
      role: "user" as const,
      content: "hello world",
      realtimeItemId,
    };

    const first = await POST(
      postRequest({ sessionId: fixture.sessionId, body, token }),
      paramsFor(fixture.sessionId),
    );
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { item: { id: string } };
    expect(firstJson.item.id).toBeDefined();

    const second = await POST(
      postRequest({ sessionId: fixture.sessionId, body, token }),
      paramsFor(fixture.sessionId),
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { item: { id: string } };
    expect(secondJson.item.id).toBe(firstJson.item.id);

    const rows = await readTestVoiceChatItems(fixture.sessionId);
    const userRows = rows.filter((r) => {
      return r.role === "user";
    });
    expect(userRows).toHaveLength(1);
  });

  it("appends an assistant transcript item with its realtime id", async () => {
    const fixture = await seedFixture();
    const token = tokenFor(fixture);
    const realtimeItemId = `msg_${randomUUID()}`;
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: {
          role: "assistant",
          content: "yes I can do that",
          realtimeItemId,
        },
        token,
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(200);
    const rows = await readTestVoiceChatItems(fixture.sessionId);
    const assistantRows = rows.filter((r) => {
      return r.role === "assistant";
    });
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]?.content).toBe("yes I can do that");
  });

  it("appends a system_note interruption row keyed by truncate:<itemId>", async () => {
    const fixture = await seedFixture();
    const token = tokenFor(fixture);
    const assistantId = `msg_${randomUUID()}`;
    const response = await POST(
      postRequest({
        sessionId: fixture.sessionId,
        body: {
          role: "system_note",
          content: JSON.stringify({
            type: "assistant_interrupted",
            assistantRealtimeItemId: assistantId,
            heardText: "okay let me",
            audioEndMs: 1234,
          }),
          realtimeItemId: `truncate:${assistantId}`,
        },
        token,
      }),
      paramsFor(fixture.sessionId),
    );
    expect(response.status).toBe(200);
  });

  it("returns 404 when the path's session id is unknown", async () => {
    const fixture = await seedFixture();
    const unknownId = randomUUID();
    const token = tokenFor(fixture, { voiceChatSessionId: unknownId });
    const response = await POST(
      postRequest({
        sessionId: unknownId,
        body: { role: "user", content: "hi", realtimeItemId: randomUUID() },
        token,
      }),
      paramsFor(unknownId),
    );
    expect(response.status).toBe(404);
  });
});
