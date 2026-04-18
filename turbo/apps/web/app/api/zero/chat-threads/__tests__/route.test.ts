import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  getOrgCacheEntry,
  insertTestChatMessage,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

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

  it("reports isRead=false and isArchived=false for a thread with no messages", async () => {
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
    expect(data.threads[0].isRead).toBe(false);
    expect(data.threads[0].isArchived).toBe(false);
  });

  it("reports isRead based on the last message's readAt", async () => {
    const readCreate = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Read" }),
      }),
    );
    const { id: readId } = await readCreate.json();
    await insertTestChatMessage({
      chatThreadId: readId,
      role: "assistant",
      content: "hi",
      readAt: new Date(),
    });

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

describe("POST /api/zero/chat-threads - sourceScheduleRunId", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("chat-src"));
    testComposeId = composeId;
  });

  it("accepts a UUID sourceScheduleRunId and creates the thread", async () => {
    const sourceScheduleRunId = crypto.randomUUID();
    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testComposeId,
          sourceScheduleRunId,
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.id).toBeDefined();
  });

  it("rejects a non-UUID sourceScheduleRunId with 400", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testComposeId,
          sourceScheduleRunId: "not-a-uuid",
        }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(400);
  });
});
