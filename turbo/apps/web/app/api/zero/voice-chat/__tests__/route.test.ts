import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  createTestRunInDb,
} from "../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import * as zeroRunModule from "../../../../../src/lib/zero/zero-run-service";
import * as zeroRunCancelModule from "../../../../../src/lib/zero/zero-run-cancel";

// Mock isFeatureEnabled to return true by default
vi.mock("@vm0/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vm0/core")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

// Import route handlers
import { POST } from "../route";
import { POST as heartbeatPOST } from "../[id]/heartbeat/route";
import { POST as endPOST } from "../[id]/end/route";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zvc");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

describe("Voice-Chat API", () => {
  let user: UserContext;
  let orgId: string;
  let agentId: string;
  let createZeroRunSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const org = await setupOrg(user.userId);
    orgId = org.orgId;
    mockIsFeatureEnabled.mockReturnValue(true);

    const compose = await createTestCompose(uniqueId("voice-agent"));
    agentId = compose.composeId;

    // Create a real agent_runs record so FK constraint is satisfied
    const testRun = await createTestRunInDb(user.userId, compose.composeId);
    createZeroRunSpy = vi
      .spyOn(zeroRunModule, "createZeroRun")
      .mockResolvedValue({
        runId: testRun.runId,
        status: "queued",
        createdAt: new Date(),
      });

    vi.spyOn(zeroRunCancelModule, "cancelRun").mockResolvedValue({
      runId: testRun.runId,
      previousStatus: "running",
      orgId,
      sandboxId: null,
      runnerGroup: null,
    });
  });

  describe("POST /api/zero/voice-chat (create session)", () => {
    it("should create a session and dispatch worker", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/zero/voice-chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.session).toBeDefined();
      expect(data.session.id).toBeDefined();
      expect(data.session.status).toBe("active");
      expect(data.session.runId).toBeDefined();
      expect(createZeroRunSpy).toHaveBeenCalledOnce();
    });

    it("should reject duplicate active session (409)", async () => {
      const makeRequest = () => {
        return createTestRequest("http://localhost:3000/api/zero/voice-chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId }),
        });
      };

      // First call succeeds
      const first = await POST(makeRequest());
      expect(first.status).toBe(200);

      // Second call should conflict
      const second = await POST(makeRequest());
      expect(second.status).toBe(409);

      const data = await second.json();
      expect(data.error.code).toBe("CONFLICT");
    });

    it("should return 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/zero/voice-chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("should return 403 when feature flag is disabled", async () => {
      mockIsFeatureEnabled.mockReturnValue(false);

      const request = createTestRequest(
        "http://localhost:3000/api/zero/voice-chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(403);

      const data = await response.json();
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("should return 400 when agentId is missing", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/zero/voice-chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
    });
  });

  describe("POST /api/zero/voice-chat/[id]/heartbeat", () => {
    it("should update heartbeat for active session", async () => {
      // Create a session first
      const createReq = createTestRequest(
        "http://localhost:3000/api/zero/voice-chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId }),
        },
      );
      const createRes = await POST(createReq);
      const { session } = await createRes.json();

      // Send heartbeat
      const heartbeatReq = createTestRequest(
        `http://localhost:3000/api/zero/voice-chat/${session.id}/heartbeat`,
        { method: "POST" },
      );
      const response = await heartbeatPOST(heartbeatReq, {
        params: Promise.resolve({ id: session.id }),
      });
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.ok).toBe(true);
    });

    it("should return 404 for non-existent session", async () => {
      const heartbeatReq = createTestRequest(
        "http://localhost:3000/api/zero/voice-chat/00000000-0000-0000-0000-000000000000/heartbeat",
        { method: "POST" },
      );
      const response = await heartbeatPOST(heartbeatReq, {
        params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
      });
      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });

  describe("POST /api/zero/voice-chat/[id]/end", () => {
    it("should end an active session", async () => {
      // Create a session first
      const createReq = createTestRequest(
        "http://localhost:3000/api/zero/voice-chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId }),
        },
      );
      const createRes = await POST(createReq);
      const { session } = await createRes.json();

      // End the session
      const endReq = createTestRequest(
        `http://localhost:3000/api/zero/voice-chat/${session.id}/end`,
        { method: "POST" },
      );
      const response = await endPOST(endReq, {
        params: Promise.resolve({ id: session.id }),
      });
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.ok).toBe(true);

      // Heartbeat should now fail since session is ended
      const heartbeatReq = createTestRequest(
        `http://localhost:3000/api/zero/voice-chat/${session.id}/heartbeat`,
        { method: "POST" },
      );
      const heartbeatRes = await heartbeatPOST(heartbeatReq, {
        params: Promise.resolve({ id: session.id }),
      });
      expect(heartbeatRes.status).toBe(404);
    });

    it("should return 404 for non-existent session", async () => {
      const endReq = createTestRequest(
        "http://localhost:3000/api/zero/voice-chat/00000000-0000-0000-0000-000000000000/end",
        { method: "POST" },
      );
      const response = await endPOST(endReq, {
        params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
      });
      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });
});
