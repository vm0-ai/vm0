import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { seedTestCompose } from "../../../../__tests__/db-test-seeders/agents";
import { initServices } from "../../../init-services";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route covers these services yet
import {
  createVoiceChatCandidateSession,
  getVoiceChatCandidateSession,
  heartbeatVoiceChatCandidateSession,
  endVoiceChatCandidateSession,
} from "../session-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify DB side-effects directly
import { featureCandidateVoiceChatSessions } from "../../../../db/schema/voice-chat-candidate";

const context = testContext();

async function seedAgent() {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: test exercises services directly, no API route
  initServices();
  const { userId, orgId } = await context.setupUser();
  const { composeId } = await seedTestCompose({
    userId,
    orgId,
    name: uniqueId("vcc-compose"),
  });
  return { userId, orgId, agentId: composeId };
}

describe("createVoiceChatCandidateSession", () => {
  it("creates a row with the expected defaults", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    const session = await createVoiceChatCandidateSession({
      orgId,
      userId,
      agentId,
    });

    expect(session.orgId).toBe(orgId);
    expect(session.userId).toBe(userId);
    expect(session.agentId).toBe(agentId);
    expect(session.mode).toBe("chat");
    expect(session.status).toBe("active");
    expect(session.context).toBeNull();
    expect(session.contextSeq).toBe(0);
    expect(session.contextVersion).toBe(0);
    expect(session.reasoningStatus).toBe("idle");
    expect(session.reasoningPending).toBe(false);
    expect(session.lastReasoningAt).toBeNull();
    expect(session.endedAt).toBeNull();
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.lastHeartbeatAt).toBeInstanceOf(Date);
  });
});

describe("getVoiceChatCandidateSession", () => {
  it("returns the session row by id", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();
    const created = await createVoiceChatCandidateSession({
      orgId,
      userId,
      agentId,
    });

    const fetched = await getVoiceChatCandidateSession(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.status).toBe("active");
  });

  it("returns null for a nonexistent id", async () => {
    context.setupMocks();
    const fetched = await getVoiceChatCandidateSession(randomUUID());
    expect(fetched).toBeNull();
  });
});

describe("heartbeatVoiceChatCandidateSession", () => {
  it("advances lastHeartbeatAt when the session is active", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();
    const created = await createVoiceChatCandidateSession({
      orgId,
      userId,
      agentId,
    });
    const before = created.lastHeartbeatAt;

    // Small delay to ensure the timestamp can move forward at millisecond resolution.
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });

    await heartbeatVoiceChatCandidateSession(created.id);

    const after = await getVoiceChatCandidateSession(created.id);
    expect(after).not.toBeNull();
    expect(after!.lastHeartbeatAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("is a no-op when the session is already ended", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();
    const created = await createVoiceChatCandidateSession({
      orgId,
      userId,
      agentId,
    });
    await endVoiceChatCandidateSession(created.id);

    const endedBefore = await getVoiceChatCandidateSession(created.id);
    const beforeHeartbeat = endedBefore!.lastHeartbeatAt;

    await heartbeatVoiceChatCandidateSession(created.id);

    const endedAfter = await getVoiceChatCandidateSession(created.id);
    expect(endedAfter!.status).toBe("ended");
    expect(endedAfter!.lastHeartbeatAt.getTime()).toBe(
      beforeHeartbeat.getTime(),
    );
  });

  it("does not throw when the session id does not exist", async () => {
    context.setupMocks();
    await expect(
      heartbeatVoiceChatCandidateSession(randomUUID()),
    ).resolves.toBeUndefined();
  });
});

describe("endVoiceChatCandidateSession", () => {
  it("flips status to ended and sets endedAt", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();
    const created = await createVoiceChatCandidateSession({
      orgId,
      userId,
      agentId,
    });

    await endVoiceChatCandidateSession(created.id);

    // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify end side-effects
    const db = globalThis.services.db;
    const [row] = await db
      .select()
      .from(featureCandidateVoiceChatSessions)
      .where(eq(featureCandidateVoiceChatSessions.id, created.id));
    expect(row!.status).toBe("ended");
    expect(row!.endedAt).not.toBeNull();
  });

  it("is idempotent on a second call", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();
    const created = await createVoiceChatCandidateSession({
      orgId,
      userId,
      agentId,
    });

    await endVoiceChatCandidateSession(created.id);
    const firstEnd = await getVoiceChatCandidateSession(created.id);
    const firstEndedAt = firstEnd!.endedAt;

    await expect(
      endVoiceChatCandidateSession(created.id),
    ).resolves.toBeUndefined();

    const secondEnd = await getVoiceChatCandidateSession(created.id);
    expect(secondEnd!.status).toBe("ended");
    // endedAt should not be overwritten on the idempotent call.
    expect(secondEnd!.endedAt!.getTime()).toBe(firstEndedAt!.getTime());
  });

  it("throws notFound when the session id does not exist", async () => {
    context.setupMocks();
    await expect(
      endVoiceChatCandidateSession(randomUUID()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
