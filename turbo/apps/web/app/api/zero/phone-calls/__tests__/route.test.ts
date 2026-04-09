import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { POST, GET } from "../route";
import {
  createTestRequest,
  insertOrgDefaultModelProvider,
  setOrgAgentphoneNumberId,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { createPhoneOrg } from "../../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../../src/mocks/server";
import { reloadEnv } from "../../../../../src/env";

vi.mock("@clerk/nextjs/server");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const AGENTPHONE_BASE = "https://api.agentphone.to";

const context = testContext();

describe("POST /api/zero/phone-calls", () => {
  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("AGENTPHONE_API_KEY", "test-agentphone-key");
    reloadEnv();
    await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone-calls",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toNumber: "+14155551234" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("should reject invalid E.164 phone number", async () => {
    const user = await context.setupUser();
    await createPhoneOrg(user.orgId);

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone-calls",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toNumber: "555-1234" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("should throw when org has no agentphone configured", async () => {
    // Default org has no agentphone agent set up — route lets the error propagate
    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone-calls",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toNumber: "+14155551234" }),
      },
    );

    await expect(POST(request)).rejects.toThrow(
      "Phone is not configured for this org",
    );
  });

  it("should create outbound call and return 201 with callId", async () => {
    const user = await context.setupUser();
    const { agentphoneAgentId } = await createPhoneOrg(user.orgId);

    // Attach a number ID to the org for the outbound call
    await setOrgAgentphoneNumberId(user.orgId, "num_test_123");
    await insertOrgDefaultModelProvider(user.orgId, "anthropic");

    server.use(
      http.post(`${AGENTPHONE_BASE}/v1/calls`, () => {
        return HttpResponse.json({
          id: "call_new_456",
          status: "initiated",
          agentId: agentphoneAgentId,
        });
      }),
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone-calls",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toNumber: "+14155551234" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(201);
    const data = await response.json();
    expect((data as Record<string, string>).callId).toBe("call_new_456");
    expect((data as Record<string, string>).status).toBe("initiated");
  });
});

describe("GET /api/zero/phone-calls", () => {
  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("AGENTPHONE_API_KEY", "test-agentphone-key");
    reloadEnv();
    await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone-calls",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("should throw when org has no agentphone configured", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone-calls",
    );

    await expect(GET(request)).rejects.toThrow(
      "Phone is not configured for this org",
    );
  });

  it("should return paginated call list for org", async () => {
    const user = await context.setupUser();
    const { agentphoneAgentId } = await createPhoneOrg(user.orgId);

    server.use(
      http.get(
        `${AGENTPHONE_BASE}/v1/agents/${agentphoneAgentId}/calls`,
        () => {
          return HttpResponse.json({
            data: [
              { id: "call_001", status: "completed", duration: 120 },
              { id: "call_002", status: "completed", duration: 60 },
            ],
          });
        },
      ),
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone-calls",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect((data as { data: unknown[] }).data).toHaveLength(2);
    expect((data as { total: number }).total).toBe(2);
    expect((data as { hasMore: boolean }).hasMore).toBe(false);
  });

  it("should respect limit and offset query params", async () => {
    const user = await context.setupUser();
    const { agentphoneAgentId } = await createPhoneOrg(user.orgId);

    server.use(
      http.get(
        `${AGENTPHONE_BASE}/v1/agents/${agentphoneAgentId}/calls`,
        () => {
          return HttpResponse.json({
            data: [{ id: "call_001" }, { id: "call_002" }, { id: "call_003" }],
          });
        },
      ),
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone-calls?limit=1&offset=1",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    const callData = data as {
      data: Array<Record<string, unknown>>;
      total: number;
      hasMore: boolean;
    };
    expect(callData.data).toHaveLength(1);
    expect(callData.data[0]!.id).toBe("call_002");
    expect(callData.total).toBe(3);
    expect(callData.hasMore).toBe(true);
  });
});
