import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { testContext } from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import {
  grantCreditsToOrg,
  seedRealtimeBillingPricing,
} from "../../../../../../../src/__tests__/db-test-seeders/credits";
import {
  getActiveRelaySession,
  getUsageEventsForOrg,
} from "../../../../../../../src/__tests__/db-test-assertions/voice-chat-billing";
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

interface SeededSession {
  readonly orgId: string;
  readonly userId: string;
  readonly sessionId: string;
}

async function seedSessionFixture(): Promise<SeededSession> {
  context.setupMocks();
  const user = await context.setupUser();
  const userId = user.userId;
  const org = await setupCandidateOrg(userId);
  const orgId = org.orgId;
  // Set Trinity ON before seeding the session — `createSession` POST gates
  // on `isVoiceChatEnabled`. The default mockReturnValue(true) handles ON,
  // but tests that mutate the mock between fixtures need this guard.
  mockIsFeatureEnabled.mockReturnValue(true);
  const { agentId } = await seedCandidateAgent(userId, orgId);
  const session = await seedCandidateSession({ orgId, userId, agentId });
  await grantCreditsToOrg(orgId, 1_000_000);
  await seedRealtimeBillingPricing();
  return { orgId, userId, sessionId: session.id };
}

function happyPathBody(
  overrides: Partial<{
    providerEventId: string;
    eventType: "response.done" | "transcription.completed";
    inputTextTokens: number;
    inputAudioTokens: number;
    inputCachedTextTokens: number;
    inputCachedAudioTokens: number;
    outputTextTokens: number;
    outputAudioTokens: number;
  }> = {},
) {
  return {
    providerEventId: `evt_${randomUUID()}`,
    eventType: "response.done" as const,
    inputTextTokens: 100,
    inputAudioTokens: 500,
    inputCachedTextTokens: 0,
    inputCachedAudioTokens: 0,
    outputTextTokens: 200,
    outputAudioTokens: 1000,
    ...overrides,
  };
}

describe("POST /api/zero/voice-chat-candidate/:id/usage", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(
      postRequest(`/${randomUUID()}/usage`, happyPathBody()),
      paramsFor(randomUUID()),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 when Trinity is disabled", async () => {
    const seeded = await seedSessionFixture();
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await POST(
      postRequest(`/${seeded.sessionId}/usage`, happyPathBody()),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(404);
  });

  it("returns 200 no-op when VoiceChatRealtimeBilling is OFF", async () => {
    const seeded = await seedSessionFixture();
    setFlags({
      [FeatureSwitchKey.Trinity]: true,
      [FeatureSwitchKey.VoiceChatRealtimeBilling]: false,
    });
    const response = await POST(
      postRequest(`/${seeded.sessionId}/usage`, happyPathBody()),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { creditsExhausted: boolean };
    expect(body.creditsExhausted).toBe(false);

    const rows = await getUsageEventsForOrg(seeded.orgId);
    expect(rows).toHaveLength(0);
  });

  it("returns 404 when the session belongs to another user", async () => {
    const seeded = await seedSessionFixture();
    // Spoof a different authenticated user.
    mockClerk({
      userId: `user_${randomUUID()}`,
      orgId: seeded.orgId,
      orgRole: "org:admin",
    });
    const response = await POST(
      postRequest(`/${seeded.sessionId}/usage`, happyPathBody()),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 when a token field exceeds the cap", async () => {
    const seeded = await seedSessionFixture();
    const response = await POST(
      postRequest(
        `/${seeded.sessionId}/usage`,
        happyPathBody({ inputAudioTokens: 200_001 }),
      ),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when transcription includes outputAudioTokens", async () => {
    const seeded = await seedSessionFixture();
    const response = await POST(
      postRequest(
        `/${seeded.sessionId}/usage`,
        happyPathBody({
          eventType: "transcription.completed",
          // Transcription doesn't have audio output; reject.
          outputAudioTokens: 100,
          inputAudioTokens: 50,
          outputTextTokens: 25,
        }),
      ),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(400);
  });

  it("inserts six usage_event rows for a full response.done", async () => {
    const seeded = await seedSessionFixture();
    const body = happyPathBody({
      inputCachedTextTokens: 50,
      inputCachedAudioTokens: 75,
    });
    const response = await POST(
      postRequest(`/${seeded.sessionId}/usage`, body),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(200);

    const rows = await getUsageEventsForOrg(seeded.orgId);
    expect(rows).toHaveLength(6);
    expect(
      rows.every((r) => {
        return r.provider === "gpt-realtime-2";
      }),
    ).toBe(true);
    expect(
      rows.every((r) => {
        return r.status === "processed";
      }),
    ).toBe(true);
    const totalCharged = rows.reduce((sum, r) => {
      return sum + (r.creditsCharged ?? 0);
    }, 0);
    expect(totalCharged).toBeGreaterThan(0);
  });

  it("inserts only non-zero rows when some token fields are zero", async () => {
    const seeded = await seedSessionFixture();
    const response = await POST(
      postRequest(
        `/${seeded.sessionId}/usage`,
        happyPathBody({
          inputTextTokens: 0,
          inputAudioTokens: 0,
          inputCachedTextTokens: 0,
          inputCachedAudioTokens: 0,
          outputTextTokens: 0,
          outputAudioTokens: 1000,
        }),
      ),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(200);

    const rows = await getUsageEventsForOrg(seeded.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("tokens.output.audio");
  });

  it("inserts three rows for transcription.completed", async () => {
    const seeded = await seedSessionFixture();
    const response = await POST(
      postRequest(
        `/${seeded.sessionId}/usage`,
        happyPathBody({
          eventType: "transcription.completed",
          inputAudioTokens: 600,
          inputTextTokens: 50,
          outputTextTokens: 80,
          outputAudioTokens: undefined,
          inputCachedTextTokens: 0,
          inputCachedAudioTokens: 0,
        }),
      ),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(200);

    const rows = await getUsageEventsForOrg(seeded.orgId);
    expect(rows).toHaveLength(3);
    expect(
      rows.every((r) => {
        return r.provider === "gpt-4o-mini-transcribe";
      }),
    ).toBe(true);
  });

  it("logs and 200s with no rows when transcription usage is all-zero", async () => {
    const seeded = await seedSessionFixture();
    const response = await POST(
      postRequest(
        `/${seeded.sessionId}/usage`,
        happyPathBody({
          eventType: "transcription.completed",
          inputAudioTokens: 0,
          inputTextTokens: 0,
          outputTextTokens: 0,
          outputAudioTokens: undefined,
          inputCachedTextTokens: 0,
          inputCachedAudioTokens: 0,
        }),
      ),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { creditsExhausted: boolean };
    expect(body.creditsExhausted).toBe(false);

    const rows = await getUsageEventsForOrg(seeded.orgId);
    expect(rows).toHaveLength(0);
  });

  it("collapses replays of the same providerEventId via the unique index", async () => {
    const seeded = await seedSessionFixture();
    const body = happyPathBody({
      providerEventId: "evt_replay",
      inputTextTokens: 100,
      inputAudioTokens: 0,
      inputCachedTextTokens: 0,
      inputCachedAudioTokens: 0,
      outputTextTokens: 0,
      outputAudioTokens: 0,
    });
    await POST(
      postRequest(`/${seeded.sessionId}/usage`, body),
      paramsFor(seeded.sessionId),
    );
    await POST(
      postRequest(`/${seeded.sessionId}/usage`, body),
      paramsFor(seeded.sessionId),
    );

    const rows = await getUsageEventsForOrg(seeded.orgId);
    expect(rows).toHaveLength(1);
  });

  it("returns creditsExhausted: true when settlement drains the org", async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const userId = user.userId;
    const org = await setupCandidateOrg(userId);
    const orgId = org.orgId;
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ orgId, userId, agentId });
    await seedRealtimeBillingPricing();
    // Just enough credits to be charged but not survive: pricing seed uses
    // unitPrice=1 / unitSize=1_000_000 → 1000 audio tokens charges 1000 /
    // 1_000_000 ≈ 0 credits. Use a small grant + large token quantity to
    // force exhaustion.
    await grantCreditsToOrg(orgId, 1);
    mockIsFeatureEnabled.mockReturnValue(true);

    const response = await POST(
      postRequest(
        `/${session.id}/usage`,
        happyPathBody({
          inputAudioTokens: 100_000,
          outputAudioTokens: 100_000,
          inputTextTokens: 0,
          inputCachedTextTokens: 0,
          inputCachedAudioTokens: 0,
          outputTextTokens: 0,
        }),
      ),
      paramsFor(session.id),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { creditsExhausted: boolean };
    expect(body.creditsExhausted).toBe(true);
  });

  it("updates last_usage_at on the active relay-session row", async () => {
    const seeded = await seedSessionFixture();

    // Seed a relay-session row by calling session-started directly.
    const { POST: sessionStartedPOST } =
      await import("../../session-started/route");
    await sessionStartedPOST(
      postRequest(`/${seeded.sessionId}/session-started`, {}),
      paramsFor(seeded.sessionId),
    );

    const before = await getActiveRelaySession(seeded.sessionId);
    expect(before).toBeDefined();
    expect(before?.lastUsageAt).toBeNull();

    await POST(
      postRequest(`/${seeded.sessionId}/usage`, happyPathBody()),
      paramsFor(seeded.sessionId),
    );

    const after = await getActiveRelaySession(seeded.sessionId);
    expect(after?.lastUsageAt).not.toBeNull();
  });

  it("succeeds even when no relay-session row exists (last_usage_at soft-fail)", async () => {
    const seeded = await seedSessionFixture();
    const response = await POST(
      postRequest(`/${seeded.sessionId}/usage`, happyPathBody()),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(200);
  });

  it("bills response.done even when status would be cancelled (barge-in)", async () => {
    const seeded = await seedSessionFixture();
    // The route doesn't see `status` — it only consumes the token fields the
    // browser extracted from `response.done.usage`. This test asserts a
    // partial-usage cancelled response still produces rows; future
    // contributors removing rows on "cancelled" would lose revenue.
    const response = await POST(
      postRequest(
        `/${seeded.sessionId}/usage`,
        happyPathBody({
          // Partial — barge-in stopped the assistant after a few hundred
          // output audio tokens.
          inputTextTokens: 50,
          inputAudioTokens: 200,
          inputCachedTextTokens: 0,
          inputCachedAudioTokens: 0,
          outputTextTokens: 10,
          outputAudioTokens: 250,
        }),
      ),
      paramsFor(seeded.sessionId),
    );
    expect(response.status).toBe(200);

    const rows = await getUsageEventsForOrg(seeded.orgId);
    expect(rows.length).toBeGreaterThan(0);
  });
});
