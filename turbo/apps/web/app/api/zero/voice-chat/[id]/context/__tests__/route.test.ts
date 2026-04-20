import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  createTestOrg,
  createTestVoiceChatSession,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../../src/env";
import { mockAblyPublish } from "../../../../../../../src/__tests__/ably-mock";

vi.mock("@vm0/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vm0/core")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const { GET, POST } = await import("../route");

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/voice-chat";

function contextUrl(sessionId: string, query?: string): string {
  const base = `${BASE_URL}/${sessionId}/context`;
  return query ? `${base}?${query}` : base;
}

function paramsFor(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function setupOrg(userId: string) {
  const slug = uniqueId("zvc");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

async function createSession(orgId: string, userId: string, status = "active") {
  return createTestVoiceChatSession(orgId, userId, status);
}

describe("GET /api/zero/voice-chat/[id]/context", () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupOrg(userId);
    orgId = org.orgId;
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await GET(
      createTestRequest(contextUrl("any-id")),
      paramsFor("any-id"),
    );
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 403 when feature flag is disabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await GET(
      createTestRequest(contextUrl("any-id")),
      paramsFor("any-id"),
    );
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("should return 404 for non-existent session", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const response = await GET(
      createTestRequest(contextUrl(fakeId)),
      paramsFor(fakeId),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("should return empty events array for new session", async () => {
    const session = await createSession(orgId, userId);
    const response = await GET(
      createTestRequest(contextUrl(session.id)),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.events).toEqual([]);
  });

  it("should return events ordered by seq", async () => {
    const session = await createSession(orgId, userId);

    // Insert events via POST
    for (const text of ["first", "second", "third"]) {
      await POST(
        createTestRequest(contextUrl(session.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "user",
            type: "speech",
            content: text,
          }),
        }),
        paramsFor(session.id),
      );
    }

    const response = await GET(
      createTestRequest(contextUrl(session.id)),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.events).toHaveLength(3);
    expect(body.events[0].content).toBe("first");
    expect(body.events[1].content).toBe("second");
    expect(body.events[2].content).toBe("third");
    expect(body.events[0].seq).toBeLessThan(body.events[1].seq);
    expect(body.events[1].seq).toBeLessThan(body.events[2].seq);
  });

  it("should return 400 for non-numeric after parameter", async () => {
    const session = await createSession(orgId, userId);
    const response = await GET(
      createTestRequest(contextUrl(session.id, "after=abc")),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 for negative after parameter", async () => {
    const session = await createSession(orgId, userId);
    const response = await GET(
      createTestRequest(contextUrl(session.id, "after=-1")),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should filter events with ?after=seq", async () => {
    const session = await createSession(orgId, userId);

    // Insert two events
    await POST(
      createTestRequest(contextUrl(session.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "user",
          type: "speech",
          content: "first",
        }),
      }),
      paramsFor(session.id),
    );
    await POST(
      createTestRequest(contextUrl(session.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "slow-brain",
          type: "response",
          content: "second",
        }),
      }),
      paramsFor(session.id),
    );

    // Get all events to find the first seq
    const allRes = await GET(
      createTestRequest(contextUrl(session.id)),
      paramsFor(session.id),
    );
    const allBody = await allRes.json();
    const firstSeq = allBody.events[0].seq;

    // Filter after first seq
    const response = await GET(
      createTestRequest(contextUrl(session.id, `after=${firstSeq}`)),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].content).toBe("second");
  });
});

describe("POST /api/zero/voice-chat/[id]/context", () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    mockAblyPublish.mockClear();
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupOrg(userId);
    orgId = org.orgId;
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(
      createTestRequest(contextUrl("any-id"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "user",
          type: "speech",
          content: "hello",
        }),
      }),
      paramsFor("any-id"),
    );
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should append event and return with seq", async () => {
    const session = await createSession(orgId, userId);
    const response = await POST(
      createTestRequest(contextUrl(session.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "fast-brain",
          type: "speech",
          content: "hello world",
        }),
      }),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.event).toBeDefined();
    expect(body.event.source).toBe("fast-brain");
    expect(body.event.type).toBe("speech");
    expect(body.event.content).toBe("hello world");
    expect(typeof body.event.seq).toBe("number");
    expect(body.event.id).toBeDefined();
  });

  it("should accept meeting-prompt event type", async () => {
    const session = await createSession(orgId, userId);
    const response = await POST(
      createTestRequest(contextUrl(session.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "user",
          type: "meeting-prompt",
          content: "discuss Q3 roadmap",
        }),
      }),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.event.type).toBe("meeting-prompt");
    expect(body.event.source).toBe("user");
  });

  it("should reject invalid source", async () => {
    const session = await createSession(orgId, userId);
    const response = await POST(
      createTestRequest(contextUrl(session.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "invalid",
          type: "speech",
          content: "hello",
        }),
      }),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("source");
  });

  it("should reject invalid type", async () => {
    const session = await createSession(orgId, userId);
    const response = await POST(
      createTestRequest(contextUrl(session.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "user",
          type: "invalid-type",
          content: "hello",
        }),
      }),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("type");
  });

  it("should reject if session is not active", async () => {
    const session = await createSession(orgId, userId, "ended");
    const response = await POST(
      createTestRequest(contextUrl(session.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "user",
          type: "speech",
          content: "hello",
        }),
      }),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("not active");
  });

  it.each(["directive", "thinking", "observation"] as const)(
    "should accept slow brain event type: %s",
    async (type) => {
      const session = await createSession(orgId, userId);
      const response = await POST(
        createTestRequest(contextUrl(session.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "slow-brain",
            type,
            content: "test content",
          }),
        }),
        paramsFor(session.id),
      );
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.event.type).toBe(type);
      expect(body.event.source).toBe("slow-brain");
    },
  );

  it.each(["preparation-ready", "request-slow-brain"] as const)(
    "should accept system event type: %s",
    async (type) => {
      const session = await createSession(orgId, userId);
      const response = await POST(
        createTestRequest(contextUrl(session.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "system",
            type,
          }),
        }),
        paramsFor(session.id),
      );
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.event.type).toBe(type);
      expect(body.event.source).toBe("system");
    },
  );

  it("should produce incrementing seq numbers", async () => {
    const session = await createSession(orgId, userId);

    const res1 = await POST(
      createTestRequest(contextUrl(session.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "system",
          type: "session-start",
        }),
      }),
      paramsFor(session.id),
    );
    const body1 = await res1.json();

    const res2 = await POST(
      createTestRequest(contextUrl(session.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "user",
          type: "speech",
          content: "hi",
        }),
      }),
      paramsFor(session.id),
    );
    const body2 = await res2.json();

    expect(body2.event.seq).toBeGreaterThan(body1.event.seq);
  });

  it("should publish voice session signal after appending context event", async () => {
    vi.stubEnv("ABLY_API_KEY", "test-key:test-secret");
    reloadEnv();

    const session = await createSession(orgId, userId);
    const response = await POST(
      createTestRequest(contextUrl(session.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "user",
          type: "speech",
          content: "hello",
        }),
      }),
      paramsFor(session.id),
    );
    expect(response.status).toBe(200);

    // Flush the after() callback to trigger signal publishing
    await context.mocks.flushAfter();

    expect(mockAblyPublish).toHaveBeenCalledWith(`voice:${session.id}`, null);
  });
});
