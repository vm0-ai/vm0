import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { seedTestCompose } from "../../../../__tests__/db-test-seeders/agents";
import { initServices } from "../../../init-services";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route covers these services yet
import {
  createVoiceChatCandidateSession,
  endVoiceChatCandidateSession,
} from "../session-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route covers these services yet
import {
  appendVoiceChatCandidateItem,
  readVoiceChatCandidateItems,
  readVoiceChatCandidateItemsSince,
} from "../item-service";

const context = testContext();

async function seedActiveSession() {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: test exercises services directly, no API route
  initServices();
  const { userId, orgId } = await context.setupUser();
  const { composeId } = await seedTestCompose({
    userId,
    orgId,
    name: uniqueId("vcc-compose"),
  });
  const session = await createVoiceChatCandidateSession({
    orgId,
    userId,
    agentId: composeId,
  });
  return { userId, orgId, agentId: composeId, session };
}

describe("appendVoiceChatCandidateItem", () => {
  it("inserts a row and returns it", async () => {
    context.setupMocks();
    const { session } = await seedActiveSession();

    const item = await appendVoiceChatCandidateItem({
      sessionId: session.id,
      role: "user",
      content: "hello there",
      realtimeItemId: uniqueId("rt"),
    });

    expect(item).not.toBeNull();
    expect(item!.sessionId).toBe(session.id);
    expect(item!.role).toBe("user");
    expect(item!.content).toBe("hello there");
    expect(typeof item!.seq).toBe("number");
    expect(item!.seq).toBeGreaterThan(0);
  });

  it("returns null on duplicate (sessionId, realtimeItemId)", async () => {
    context.setupMocks();
    const { session } = await seedActiveSession();
    const realtimeItemId = uniqueId("dup");

    const first = await appendVoiceChatCandidateItem({
      sessionId: session.id,
      role: "user",
      content: "first",
      realtimeItemId,
    });
    const second = await appendVoiceChatCandidateItem({
      sessionId: session.id,
      role: "user",
      content: "second",
      realtimeItemId,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("allows multiple server-written rows with realtimeItemId=null", async () => {
    context.setupMocks();
    const { session } = await seedActiveSession();

    const a = await appendVoiceChatCandidateItem({
      sessionId: session.id,
      role: "system_note",
      content: "a",
      realtimeItemId: null,
    });
    const b = await appendVoiceChatCandidateItem({
      sessionId: session.id,
      role: "system_note",
      content: "b",
      realtimeItemId: null,
    });

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
  });

  it("rejects when the session is ended", async () => {
    context.setupMocks();
    const { session } = await seedActiveSession();
    await endVoiceChatCandidateSession(session.id);

    await expect(
      appendVoiceChatCandidateItem({
        sessionId: session.id,
        role: "user",
        content: "after end",
        realtimeItemId: uniqueId("rt"),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("throws notFound when the session does not exist", async () => {
    context.setupMocks();
    await expect(
      appendVoiceChatCandidateItem({
        sessionId: randomUUID(),
        role: "user",
        content: "ghost",
        realtimeItemId: uniqueId("rt"),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("readVoiceChatCandidateItems", () => {
  it("returns items ordered by seq ascending", async () => {
    context.setupMocks();
    const { session } = await seedActiveSession();
    await appendVoiceChatCandidateItem({
      sessionId: session.id,
      role: "user",
      content: "one",
      realtimeItemId: uniqueId("rt-a"),
    });
    await appendVoiceChatCandidateItem({
      sessionId: session.id,
      role: "assistant",
      content: "two",
      realtimeItemId: uniqueId("rt-b"),
    });
    await appendVoiceChatCandidateItem({
      sessionId: session.id,
      role: "user",
      content: "three",
      realtimeItemId: uniqueId("rt-c"),
    });

    const items = await readVoiceChatCandidateItems(session.id);
    expect(items).toHaveLength(3);
    for (let i = 1; i < items.length; i++) {
      expect(items[i]!.seq).toBeGreaterThan(items[i - 1]!.seq);
    }
    expect(
      items.map((i) => {
        return i.content;
      }),
    ).toEqual(["one", "two", "three"]);
  });

  it("filters to seq > afterSeq when provided", async () => {
    context.setupMocks();
    const { session } = await seedActiveSession();
    const a = await appendVoiceChatCandidateItem({
      sessionId: session.id,
      role: "user",
      content: "a",
      realtimeItemId: uniqueId("rt-a"),
    });
    const b = await appendVoiceChatCandidateItem({
      sessionId: session.id,
      role: "user",
      content: "b",
      realtimeItemId: uniqueId("rt-b"),
    });
    const c = await appendVoiceChatCandidateItem({
      sessionId: session.id,
      role: "user",
      content: "c",
      realtimeItemId: uniqueId("rt-c"),
    });

    const afterA = await readVoiceChatCandidateItems(session.id, a!.seq);
    expect(
      afterA.map((i) => {
        return i.id;
      }),
    ).toEqual([b!.id, c!.id]);
  });
});

describe("readVoiceChatCandidateItemsSince", () => {
  it("is equivalent to readVoiceChatCandidateItems with afterSeq", async () => {
    context.setupMocks();
    const { session } = await seedActiveSession();
    const a = await appendVoiceChatCandidateItem({
      sessionId: session.id,
      role: "user",
      content: "a",
      realtimeItemId: uniqueId("rt-a"),
    });
    await appendVoiceChatCandidateItem({
      sessionId: session.id,
      role: "user",
      content: "b",
      realtimeItemId: uniqueId("rt-b"),
    });

    const viaAfterSeq = await readVoiceChatCandidateItems(session.id, a!.seq);
    const viaSince = await readVoiceChatCandidateItemsSince(session.id, a!.seq);
    expect(
      viaSince.map((i) => {
        return i.id;
      }),
    ).toEqual(
      viaAfterSeq.map((i) => {
        return i.id;
      }),
    );
  });
});
