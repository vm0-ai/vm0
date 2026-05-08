import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { testContext } from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { getRelaySessionById } from "../../../../../../../src/__tests__/db-test-assertions/voice-chat-billing";
import {
  paramsFor,
  postRequest,
  seedCandidateAgent,
  seedCandidateSession,
  setupCandidateOrg,
} from "../../../__tests__/_helpers";

vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { POST: sessionEndedPOST } = await import("../route");
const { POST: sessionStartedPOST } =
  await import("../../session-started/route");

const context = testContext();

async function seedActiveRelaySession(): Promise<{
  orgId: string;
  userId: string;
  voiceChatSessionId: string;
  relaySessionId: string;
}> {
  context.setupMocks();
  const user = await context.setupUser();
  const userId = user.userId;
  const org = await setupCandidateOrg(userId);
  const orgId = org.orgId;
  const { agentId } = await seedCandidateAgent(userId, orgId);
  const session = await seedCandidateSession({ orgId, userId, agentId });
  const startedRes = await sessionStartedPOST(
    postRequest(`/${session.id}/session-started`, {}),
    paramsFor(session.id),
  );
  const startedBody = (await startedRes.json()) as { id: string | null };
  if (!startedBody.id) {
    throw new Error("session-started failed to seed relay row");
  }
  return {
    orgId,
    userId,
    voiceChatSessionId: session.id,
    relaySessionId: startedBody.id,
  };
}

describe("POST /api/zero/voice-chat-candidate/:id/session-ended", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await sessionEndedPOST(
      postRequest(`/${randomUUID()}/session-ended`, {
        relaySessionId: randomUUID(),
      }),
      paramsFor(randomUUID()),
    );
    expect(response.status).toBe(401);
  });

  it("transitions the active row to ended on happy path", async () => {
    const seeded = await seedActiveRelaySession();
    const response = await sessionEndedPOST(
      postRequest(`/${seeded.voiceChatSessionId}/session-ended`, {
        relaySessionId: seeded.relaySessionId,
      }),
      paramsFor(seeded.voiceChatSessionId),
    );
    expect(response.status).toBe(200);

    const row = await getRelaySessionById(seeded.relaySessionId);
    expect(row?.status).toBe("ended");
    expect(row?.endedAt).not.toBeNull();
  });

  it("is idempotent on re-call (status already ended)", async () => {
    const seeded = await seedActiveRelaySession();
    await sessionEndedPOST(
      postRequest(`/${seeded.voiceChatSessionId}/session-ended`, {
        relaySessionId: seeded.relaySessionId,
      }),
      paramsFor(seeded.voiceChatSessionId),
    );
    // Second call: row is already ended; UPDATE filters by status="active"
    // so it touches zero rows. Response is still 200.
    const response = await sessionEndedPOST(
      postRequest(`/${seeded.voiceChatSessionId}/session-ended`, {
        relaySessionId: seeded.relaySessionId,
      }),
      paramsFor(seeded.voiceChatSessionId),
    );
    expect(response.status).toBe(200);
  });

  it("returns 404 when the relay session belongs to another user", async () => {
    const seeded = await seedActiveRelaySession();
    // Spoof a different authenticated user.
    mockClerk({
      userId: `user_${randomUUID()}`,
      orgId: seeded.orgId,
      orgRole: "org:admin",
    });
    const response = await sessionEndedPOST(
      postRequest(`/${seeded.voiceChatSessionId}/session-ended`, {
        relaySessionId: seeded.relaySessionId,
      }),
      paramsFor(seeded.voiceChatSessionId),
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 when body is missing relaySessionId", async () => {
    const seeded = await seedActiveRelaySession();
    const response = await sessionEndedPOST(
      postRequest(`/${seeded.voiceChatSessionId}/session-ended`, {}),
      paramsFor(seeded.voiceChatSessionId),
    );
    expect(response.status).toBe(400);
  });
});
