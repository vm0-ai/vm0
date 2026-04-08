import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { createPhoneOrg } from "../../../../../../src/lib/zero/phone/__tests__/helpers";
import { server } from "../../../../../../src/mocks/server";
import { reloadEnv } from "../../../../../../src/env";

vi.mock("@clerk/nextjs/server");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const AGENTPHONE_BASE = "https://api.agentphone.to";

const context = testContext();

describe("GET /api/zero/phone-calls/[callId]", () => {
  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("AGENTPHONE_API_KEY", "test-agentphone-key");
    reloadEnv();
    await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone-calls/call_123",
    );
    const response = await GET(request, {
      params: Promise.resolve({ callId: "call_123" }),
    });

    expect(response.status).toBe(401);
  });

  it("should throw when org has no agentphone configured", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone-calls/call_123",
    );

    await expect(
      GET(request, { params: Promise.resolve({ callId: "call_123" }) }),
    ).rejects.toThrow("Phone is not configured for this org");
  });

  it("should return 404 when call does not belong to org agent", async () => {
    const user = await context.setupUser();
    await createPhoneOrg(user.orgId);

    // Return a call with a different agent ID
    server.use(
      http.get(`${AGENTPHONE_BASE}/v1/calls/call_other`, () => {
        return HttpResponse.json({
          id: "call_other",
          agentId: "different-agent-id",
          status: "completed",
        });
      }),
      http.get(`${AGENTPHONE_BASE}/v1/calls/call_other/transcript`, () => {
        return HttpResponse.json([]);
      }),
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone-calls/call_other",
    );
    const response = await GET(request, {
      params: Promise.resolve({ callId: "call_other" }),
    });

    expect(response.status).toBe(404);
  });

  it("should return call detail and transcript when call belongs to org agent", async () => {
    const user = await context.setupUser();
    const { agentphoneAgentId } = await createPhoneOrg(user.orgId);

    const callId = "call_owned_789";
    const mockTranscript = [
      { role: "agent", content: "Hello!" },
      { role: "user", content: "Hi there." },
    ];

    server.use(
      http.get(`${AGENTPHONE_BASE}/v1/calls/${callId}`, () => {
        return HttpResponse.json({
          id: callId,
          agentId: agentphoneAgentId,
          status: "completed",
          duration: 90,
        });
      }),
      http.get(`${AGENTPHONE_BASE}/v1/calls/${callId}/transcript`, () => {
        return HttpResponse.json(mockTranscript);
      }),
    );

    const request = createTestRequest(
      `http://localhost:3000/api/zero/phone-calls/${callId}`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ callId }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    const result = data as {
      call: Record<string, unknown>;
      transcript: unknown;
    };
    expect(result.call.id).toBe(callId);
    expect(result.call.agentId).toBe(agentphoneAgentId);
    expect(result.transcript).toEqual(mockTranscript);
  });
});
