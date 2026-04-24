import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  getOrgCacheEntry,
  insertTestChatMessage,
  setTestChatThreadLastReadMessageId,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { mockAblyPublish } from "../../../../../src/__tests__/ably-mock";
import { seedTestRun } from "../../../../../src/__tests__/db-test-seeders/runs";
import { addTestRunToThread } from "../../../../../src/__tests__/db-test-seeders/agents";

const context = testContext();

describe("POST /api/zero/chat-threads - Create Thread", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("chat-thread"));
    testComposeId = composeId;
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testComposeId,
          title: "Test thread",
        }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should create a chat thread", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testComposeId,
          title: "My thread",
        }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.createdAt).toBeDefined();
  });

  it("should return 404 for compose from a different org", async () => {
    // Create compose in a different org
    const otherOrg = await context.createAgentCompose(user.userId);
    const otherOrgEntry = await getOrgCacheEntry(otherOrg.orgId);

    // Switch to the other org and create a compose there
    mockClerk({
      userId: user.userId,
      orgId: otherOrg.orgId,
      orgSlug: otherOrgEntry!.slug,
      clerkOrgs: [
        {
          id: otherOrg.orgId,
          slug: otherOrgEntry!.slug,
          name: otherOrgEntry!.slug,
        },
      ],
    });
    const { composeId: otherComposeId } = await createTestCompose(
      uniqueId("other-org-chat"),
    );

    // Switch back to default org
    mockClerk({ userId: user.userId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: otherComposeId,
          title: "Cross-org thread",
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(404);
  });

  it("should return 404 for non-existent compose", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: "00000000-0000-0000-0000-000000000000",
          title: "Test thread",
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(404);
  });
});

describe("GET /api/zero/chat-threads - List Threads", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("chat-thread"));
    testComposeId = composeId;
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 404 for compose from a different org", async () => {
    // Create compose in a different org
    const otherOrg = await context.createAgentCompose(user.userId);
    const otherOrgEntry = await getOrgCacheEntry(otherOrg.orgId);

    // Switch to the other org and create a compose there
    mockClerk({
      userId: user.userId,
      orgId: otherOrg.orgId,
      orgSlug: otherOrgEntry!.slug,
      clerkOrgs: [
        {
          id: otherOrg.orgId,
          slug: otherOrgEntry!.slug,
          name: otherOrgEntry!.slug,
        },
      ],
    });
    const { composeId: otherComposeId } = await createTestCompose(
      uniqueId("other-org-chat"),
    );

    // Switch back to default org
    mockClerk({ userId: user.userId });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/chat-threads?agentId=${otherComposeId}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(404);
  });

  it("should return empty array when no threads exist", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.threads).toEqual([]);
  });

  it("should list created threads", async () => {
    // Create a thread first
    const createRequest = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testComposeId,
          title: "Listed thread",
        }),
      },
    );
    await POST(createRequest);

    // List threads
    const request = createTestRequest(
      `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0].title).toBe("Listed thread");
    expect(data.threads[0].id).toBeDefined();
    expect(data.threads[0].createdAt).toBeDefined();
    expect(data.threads[0].updatedAt).toBeDefined();
  });

  it("reports isRead=true and isArchived=false for a thread with no messages", async () => {
    const createRequest = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testComposeId,
          title: "Empty thread",
        }),
      },
    );
    await POST(createRequest);

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.threads).toHaveLength(1);
    // Empty threads are considered read (Slack semantics)
    expect(data.threads[0].isRead).toBe(true);
    expect(data.threads[0].isArchived).toBe(false);
  });

  it("reports isRead based on last_read_message_id", async () => {
    // Thread whose last_read_message_id matches the last message → read
    const readCreate = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Read" }),
      }),
    );
    const { id: readId } = await readCreate.json();
    const readMessage = await insertTestChatMessage({
      chatThreadId: readId,
      role: "assistant",
      content: "hi",
    });
    await setTestChatThreadLastReadMessageId(readId, readMessage.id);

    // Thread with last_read_message_id NULL → unread
    const unreadCreate = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Unread" }),
      }),
    );
    const { id: unreadId } = await unreadCreate.json();
    await insertTestChatMessage({
      chatThreadId: unreadId,
      role: "assistant",
      content: "hi",
    });
    await setTestChatThreadLastReadMessageId(unreadId, null);

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    const readThread = data.threads.find((t: { id: string }) => {
      return t.id === readId;
    });
    const unreadThread = data.threads.find((t: { id: string }) => {
      return t.id === unreadId;
    });
    expect(readThread.isRead).toBe(true);
    expect(unreadThread.isRead).toBe(false);
  });

  it("filters out threads whose last message is archived", async () => {
    const archivedCreate = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Archived" }),
      }),
    );
    const { id: archivedId } = await archivedCreate.json();
    await insertTestChatMessage({
      chatThreadId: archivedId,
      role: "assistant",
      content: "gone",
      archivedAt: new Date(),
    });

    const liveCreate = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Live" }),
      }),
    );
    const { id: liveId } = await liveCreate.json();
    await insertTestChatMessage({
      chatThreadId: liveId,
      role: "assistant",
      content: "still here",
    });

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    const ids = data.threads.map((t: { id: string }) => {
      return t.id;
    });
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(archivedId);
  });

  it("orders threads by the latest message's createdAt desc", async () => {
    const olderCreate = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Older" }),
      }),
    );
    const { id: olderId } = await olderCreate.json();
    await insertTestChatMessage({
      chatThreadId: olderId,
      role: "user",
      content: "first",
    });

    await new Promise((resolve) => {
      return setTimeout(resolve, 10);
    });

    const newerCreate = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Newer" }),
      }),
    );
    const { id: newerId } = await newerCreate.json();
    await insertTestChatMessage({
      chatThreadId: newerId,
      role: "user",
      content: "second",
    });

    const initial = await (
      await GET(
        createTestRequest(
          `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
        ),
      )
    ).json();
    expect(
      initial.threads.map((t: { id: string }) => {
        return t.id;
      }),
    ).toEqual([newerId, olderId]);

    // A new message on the older thread should bump it to the top.
    await new Promise((resolve) => {
      return setTimeout(resolve, 10);
    });
    await insertTestChatMessage({
      chatThreadId: olderId,
      role: "assistant",
      content: "reply",
    });

    const after = await (
      await GET(
        createTestRequest(
          `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
        ),
      )
    ).json();
    expect(
      after.threads.map((t: { id: string }) => {
        return t.id;
      }),
    ).toEqual([olderId, newerId]);
  });

  it("orders empty threads by their own createdAt desc", async () => {
    const firstCreate = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "First" }),
      }),
    );
    const { id: firstId } = await firstCreate.json();

    await new Promise((resolve) => {
      return setTimeout(resolve, 10);
    });

    const secondCreate = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Second" }),
      }),
    );
    const { id: secondId } = await secondCreate.json();

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
      ),
    );
    const data = await response.json();

    expect(
      data.threads.map((t: { id: string }) => {
        return t.id;
      }),
    ).toEqual([secondId, firstId]);
  });

  it("keeps a thread visible when only an earlier message is archived", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Mixed" }),
      }),
    );
    const { id: threadId } = await createRes.json();

    await insertTestChatMessage({
      chatThreadId: threadId,
      role: "user",
      content: "first",
      archivedAt: new Date(),
    });
    // A small delay so the second message has a strictly later createdAt.
    await new Promise((resolve) => {
      return setTimeout(resolve, 10);
    });
    await insertTestChatMessage({
      chatThreadId: threadId,
      role: "assistant",
      content: "second",
    });

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0].id).toBe(threadId);
    expect(data.threads[0].isArchived).toBe(false);
  });

  it("reports running=false for a thread with no runs", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "No runs" }),
      }),
    );
    await createRes.json();

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.threads[0].running).toBe(false);
  });

  it("reports running=true when a run is non-terminal", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Running" }),
      }),
    );
    const { id: threadId } = await createRes.json();
    const { runId } = await seedTestRun(user.userId, testComposeId, {
      status: "running",
    });
    await addTestRunToThread(threadId, runId, user.userId);

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    const thread = data.threads.find((t: { id: string }) => {
      return t.id === threadId;
    });
    expect(thread.running).toBe(true);
  });

  it("returns agent.id and agent.avatarUrl for scoped (agentId query) requests", async () => {
    await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Scoped agent" }),
      }),
    );

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0].agent).toBeDefined();
    expect(data.threads[0]).not.toHaveProperty("agentId");
    expect(data.threads[0].agent.id).toBe(testComposeId);
    expect(data.threads[0].agent).toHaveProperty("avatarUrl");
  });

  it("reports running=false when all runs reach terminal states", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Completed" }),
      }),
    );
    const { id: threadId } = await createRes.json();
    const { runId } = await seedTestRun(user.userId, testComposeId, {
      status: "completed",
    });
    await addTestRunToThread(threadId, runId, user.userId);

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
      ),
    );
    const data = await response.json();

    const thread = data.threads.find((t: { id: string }) => {
      return t.id === threadId;
    });
    expect(thread.running).toBe(false);
  });

  it("reports running=true when any run is non-terminal even with a terminal sibling", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Mixed runs" }),
      }),
    );
    const { id: threadId } = await createRes.json();
    const doneRun = await seedTestRun(user.userId, testComposeId, {
      status: "completed",
    });
    await addTestRunToThread(threadId, doneRun.runId, user.userId);
    const queuedRun = await seedTestRun(user.userId, testComposeId, {
      status: "queued",
    });
    await addTestRunToThread(threadId, queuedRun.runId, user.userId);

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
      ),
    );
    const data = await response.json();

    const thread = data.threads.find((t: { id: string }) => {
      return t.id === threadId;
    });
    expect(thread.running).toBe(true);
  });
});

describe("GET /api/zero/chat-threads - Unified list (agentId omitted)", () => {
  let user: UserContext;
  let composeAId: string;
  let composeBId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const a = await createTestCompose(uniqueId("unify-a"));
    composeAId = a.composeId;
    const b = await createTestCompose(uniqueId("unify-b"));
    composeBId = b.composeId;
  });

  it("returns threads for every agent in the caller's org", async () => {
    const aCreate = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: composeAId, title: "A thread" }),
      }),
    );
    const { id: aId } = await aCreate.json();
    const bCreate = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: composeBId, title: "B thread" }),
      }),
    );
    const { id: bId } = await bCreate.json();

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/chat-threads"),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    const ids = data.threads.map((t: { id: string }) => {
      return t.id;
    });
    expect(ids).toContain(aId);
    expect(ids).toContain(bId);
  });

  it("returns agent.id and agent.avatarUrl for every row", async () => {
    await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: composeAId, title: "A" }),
      }),
    );

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/chat-threads"),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0].agent).toBeDefined();
    expect(data.threads[0]).not.toHaveProperty("agentId");
    expect(data.threads[0].agent.id).toBe(composeAId);
    // avatarUrl defaults to null for a freshly seeded zero_agents row.
    expect(data.threads[0].agent).toHaveProperty("avatarUrl");
  });

  it("does not leak threads from another org", async () => {
    // Thread in the caller's default org, agent A.
    const mineCreate = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: composeAId, title: "Mine" }),
      }),
    );
    const { id: mineId } = await mineCreate.json();

    // Switch to a different org and create a compose + thread there.
    const otherOrg = await context.createAgentCompose(user.userId);
    const otherOrgEntry = await getOrgCacheEntry(otherOrg.orgId);
    mockClerk({
      userId: user.userId,
      orgId: otherOrg.orgId,
      orgSlug: otherOrgEntry!.slug,
      clerkOrgs: [
        {
          id: otherOrg.orgId,
          slug: otherOrgEntry!.slug,
          name: otherOrgEntry!.slug,
        },
      ],
    });
    const { composeId: otherComposeId } = await createTestCompose(
      uniqueId("unify-other-org"),
    );
    const otherCreate = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: otherComposeId, title: "Other org" }),
      }),
    );
    const { id: otherId } = await otherCreate.json();

    // Switch back to the original org and list unscoped.
    mockClerk({ userId: user.userId });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/chat-threads"),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    const ids = data.threads.map((t: { id: string }) => {
      return t.id;
    });
    expect(ids).toContain(mineId);
    expect(ids).not.toContain(otherId);
  });
});

describe("chat-threads - threadListChanged realtime signal", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
    mockAblyPublish.mockClear();

    const { composeId } = await createTestCompose(uniqueId("threadlist-ably"));
    testComposeId = composeId;
  });

  it("publishes threadListChanged on thread create", async () => {
    await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "T" }),
      }),
    );

    expect(mockAblyPublish).toHaveBeenCalledWith("threadListChanged", null);
  });
});

describe("POST /api/zero/chat-threads - Title Handling", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("chat-title"));
    testComposeId = composeId;
  });

  it("should use raw prompt as thread title without calling OpenRouter", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testComposeId,
          title: "How do I debug memory leaks in Node.js?",
        }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.title).toBe("How do I debug memory leaks in Node.js?");
  });

  it("should return null title when no title is provided", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testComposeId,
        }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.title).toBeNull();
  });
});
