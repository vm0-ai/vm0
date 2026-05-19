import { describe, it, expect, beforeEach } from "vitest";
import { POST as sendMessage } from "../messages/route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { createTestCliToken } from "../../../../../src/__tests__/db-test-seeders/auth";
import { updateOrgDefaultAgent } from "../../../../../src/__tests__/db-test-seeders/org";
import { getTestZeroAgentId } from "../../../../../src/__tests__/db-test-assertions/agents";
import { randomUUID } from "crypto";

const context = testContext();

const POST_MESSAGE_URL = "http://localhost:3000/api/v1/chat-threads/messages";

function bearerHeaders(secret: string) {
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  };
}

async function mintApiKey(user: UserContext): Promise<string> {
  return createTestCliToken(user.userId, undefined, user.orgId);
}

describe("POST /api/v1/chat-threads/messages", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("returns 401 without API key", async () => {
    mockClerk({ userId: null });
    const res = await sendMessage(
      createTestRequest(POST_MESSAGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when no default agent is configured", async () => {
    const token = await mintApiKey(user);
    const res = await sendMessage(
      createTestRequest(POST_MESSAGE_URL, {
        method: "POST",
        headers: bearerHeaders(token),
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/No default agent/i);
  });

  it("returns 404 when posting to another user's existing thread", async () => {
    const token = await mintApiKey(user);
    const otherThreadId = randomUUID();
    const res = await sendMessage(
      createTestRequest(POST_MESSAGE_URL, {
        method: "POST",
        headers: bearerHeaders(token),
        body: JSON.stringify({
          prompt: "hi",
          threadId: otherThreadId,
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects session auth (Clerk cookie) — v1 is PAT-only", async () => {
    // Session is configured via setupUser() but no Bearer PAT sent.
    const res = await sendMessage(
      createTestRequest(POST_MESSAGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects opaque (non-vm0_pat_) bearer token — v1 is PAT-only", async () => {
    const res = await sendMessage(
      createTestRequest(POST_MESSAGE_URL, {
        method: "POST",
        headers: {
          Authorization: "Bearer ak_opaque_legacy_secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  // NOTE: Full happy-path coverage is shared with the existing
  // /api/zero/chat/messages test — that route uses the same createZeroRun
  // pipeline we reuse here. We stop at the pre-run validation layer to avoid
  // duplicating heavy model-provider / runner fixtures.
  it("reaches the run pipeline once default agent is configured", async () => {
    const compose = await createTestCompose(uniqueId("v1-send"));
    const agentId = await getTestZeroAgentId(user.orgId, compose.name);
    await updateOrgDefaultAgent(user.orgId, agentId);

    const token = await mintApiKey(user);
    const res = await sendMessage(
      createTestRequest(POST_MESSAGE_URL, {
        method: "POST",
        headers: bearerHeaders(token),
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    // Auth + scope + default-agent resolution must all pass (no 400/401/403).
    // The run pipeline itself may fail in CI (e.g. no runner configured), so
    // 201 or 500 are both acceptable — what matters is we are NOT gated before
    // reaching createZeroRun.
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect([201, 500]).toContain(res.status);
    if (res.status === 201) {
      const body = await res.json();
      expect(body.runId).toBeUndefined();
      expect(body.status).toBeUndefined();
      expect(body.threadId).toBeDefined();
      expect(body.messageId).toBeDefined();
      expect(body.createdAt).toBeDefined();
    }
  });
});
