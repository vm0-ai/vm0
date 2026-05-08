import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { testContext } from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { getRelaySessionsForVoiceChatSession } from "../../../../../../../src/__tests__/db-test-assertions/voice-chat-billing";
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

const { isFeatureEnabled } = await import("@vm0/core/feature-switch");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

function setFlags(flags: Partial<Record<FeatureSwitchKey, boolean>>): void {
  mockIsFeatureEnabled.mockImplementation((key: FeatureSwitchKey) => {
    return flags[key] ?? false;
  });
}

const { POST } = await import("../route");

const context = testContext();

async function seedFixture(): Promise<{
  orgId: string;
  userId: string;
  sessionId: string;
}> {
  context.setupMocks();
  const user = await context.setupUser();
  const userId = user.userId;
  const org = await setupCandidateOrg(userId);
  const orgId = org.orgId;
  mockIsFeatureEnabled.mockReturnValue(true);
  const { agentId } = await seedCandidateAgent(userId, orgId);
  const session = await seedCandidateSession({ orgId, userId, agentId });
  return { orgId, userId, sessionId: session.id };
}

describe("POST /api/zero/voice-chat-candidate/:id/session-started", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(
      postRequest(`/${randomUUID()}/session-started`, {}),
      paramsFor(randomUUID()),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 when Trinity is disabled", async () => {
    const seeded = await seedFixture();
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await POST(
      postRequest(`/${seeded.sessionId}/session-started`, {}),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(404);
  });

  it("returns { id: null } when VoiceChatRealtimeBilling is OFF", async () => {
    const seeded = await seedFixture();
    setFlags({
      [FeatureSwitchKey.Trinity]: true,
      [FeatureSwitchKey.VoiceChatRealtimeBilling]: false,
    });
    const response = await POST(
      postRequest(`/${seeded.sessionId}/session-started`, {}),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string | null };
    expect(body.id).toBeNull();

    const rows = await getRelaySessionsForVoiceChatSession(seeded.sessionId);
    expect(rows).toHaveLength(0);
  });

  it("inserts an active row and returns its id on happy path", async () => {
    const seeded = await seedFixture();
    const response = await POST(
      postRequest(`/${seeded.sessionId}/session-started`, {}),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string | null };
    expect(body.id).not.toBeNull();

    const rows = await getRelaySessionsForVoiceChatSession(seeded.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.provider).toBe("openai");
    expect(rows[0]?.model).toBe("gpt-realtime-2");
    expect(rows[0]?.transcriptionModel).toBe("gpt-4o-mini-transcribe");
    expect(rows[0]?.id).toBe(body.id);
  });

  it("returns 404 when the session belongs to another user", async () => {
    const seeded = await seedFixture();
    mockClerk({
      userId: `user_${randomUUID()}`,
      orgId: seeded.orgId,
      orgRole: "org:admin",
    });
    const response = await POST(
      postRequest(`/${seeded.sessionId}/session-started`, {}),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(404);
  });
});
