import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { seedTestCompose } from "../../../../__tests__/db-test-seeders/agents";
import { initServices } from "../../../init-services";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route covers these services yet
import {
  createVoiceChatCandidateSession,
  getVoiceChatCandidateSession,
} from "../session-service";

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

describe("createVoiceChatCandidateSession (get-or-create)", () => {
  it("creates a row with the expected defaults on first call", async () => {
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
    expect(session.conversationSummary).toBeNull();
    expect(session.workingTasksSummary).toBeNull();
    expect(session.finishedTasksSummary).toBeNull();
    expect(session.summarySeq).toBe(0);
    expect(session.summaryVersion).toBe(0);
    expect(session.reasoningStatus).toBe("idle");
    expect(session.reasoningPending).toBe(false);
    expect(session.lastSummaryAt).toBeNull();
    expect(session.createdAt).toBeInstanceOf(Date);
  });

  it("returns the same row on a second call for the same (user, agent)", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    const first = await createVoiceChatCandidateSession({
      orgId,
      userId,
      agentId,
    });
    const second = await createVoiceChatCandidateSession({
      orgId,
      userId,
      agentId,
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
  });

  it("creates a separate row for a different agent under the same user", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();
    const { composeId: otherAgent } = await seedTestCompose({
      userId,
      orgId,
      name: uniqueId("vcc-compose-other"),
    });

    const first = await createVoiceChatCandidateSession({
      orgId,
      userId,
      agentId,
    });
    const otherAgentSession = await createVoiceChatCandidateSession({
      orgId,
      userId,
      agentId: otherAgent,
    });

    expect(otherAgentSession.id).not.toBe(first.id);
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
  });

  it("returns null for a nonexistent id", async () => {
    context.setupMocks();
    const fetched = await getVoiceChatCandidateSession(randomUUID());
    expect(fetched).toBeNull();
  });
});
