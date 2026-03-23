import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { GET, POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  getOrgCacheEntry,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../src/mocks/server";
import { reloadEnv } from "../../../../../src/env";

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
          agentComposeId: testComposeId,
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
          agentComposeId: testComposeId,
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
          agentComposeId: otherComposeId,
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
          agentComposeId: "00000000-0000-0000-0000-000000000000",
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
      `http://localhost:3000/api/zero/chat-threads?agentComposeId=${testComposeId}`,
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
      `http://localhost:3000/api/zero/chat-threads?agentComposeId=${otherComposeId}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(404);
  });

  it("should return empty array when no threads exist", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/zero/chat-threads?agentComposeId=${testComposeId}`,
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
          agentComposeId: testComposeId,
          title: "Listed thread",
        }),
      },
    );
    await POST(createRequest);

    // List threads
    const request = createTestRequest(
      `http://localhost:3000/api/zero/chat-threads?agentComposeId=${testComposeId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0].title).toBe("Listed thread");
    expect(data.threads[0].preview).toBe("Listed thread");
    expect(data.threads[0].id).toBeDefined();
    expect(data.threads[0].createdAt).toBeDefined();
    expect(data.threads[0].updatedAt).toBeDefined();
  });
});

describe("POST /api/zero/chat-threads - AI Title Generation", () => {
  const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("chat-title-gen"));
    testComposeId = composeId;
  });

  it("should update thread title when OpenRouter returns a title", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json({
          choices: [{ message: { content: "Debugging Node.js Memory Leaks" } }],
        });
      }),
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "How do I debug memory leaks in Node.js?",
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(201);

    // Wait for the fire-and-forget title generation to complete, then verify via GET API
    await vi.waitFor(async () => {
      const listRequest = createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentComposeId=${testComposeId}`,
      );
      const listResponse = await GET(listRequest);
      const listData = await listResponse.json();
      expect(listData.threads[0]?.title).toBe("Debugging Node.js Memory Leaks");
    });
  });

  it("should not call OpenRouter when API key is not configured", async () => {
    let openRouterCalled = false;
    server.use(
      http.post(OPENROUTER_URL, () => {
        openRouterCalled = true;
        return HttpResponse.json({
          choices: [{ message: { content: "Should not reach here" } }],
        });
      }),
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "Test without API key",
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(201);
    // Give fire-and-forget a chance to execute
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(openRouterCalled).toBe(false);
  });

  it("should not break thread creation when OpenRouter fails", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json(
          { error: "Rate limit exceeded" },
          { status: 429 },
        );
      }),
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "Test with API failure",
        }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.id).toBeDefined();

    // Give fire-and-forget a chance to execute (and fail gracefully)
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Title should remain unchanged (original title) — verified via GET API
    const listRequest = createTestRequest(
      `http://localhost:3000/api/zero/chat-threads?agentComposeId=${testComposeId}`,
    );
    const listResponse = await GET(listRequest);
    const listData = await listResponse.json();
    expect(listData.threads[0]?.title).toBe("Test with API failure");
  });
});
