import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestRequest,
  updateOrgTier,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import {
  createPhoneOrg,
  getOrgAgentphoneConfig,
} from "../../../../../../src/__tests__/api-test-helpers/phone";
import { server } from "../../../../../../src/mocks/server";
import { reloadEnv } from "../../../../../../src/env";

vi.mock("@clerk/nextjs/server");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const AGENTPHONE_BASE = "https://api.agentphone.to";

const context = testContext();

describe("POST /api/zero/phone/setup", () => {
  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("AGENTPHONE_API_KEY", "test-agentphone-key");
    vi.stubEnv("VM0_API_URL", "https://test.vm0.ai");
    reloadEnv();
    await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/setup",
      { method: "POST" },
    );
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("should reject non-team tier orgs with 403", async () => {
    const user = await context.setupUser();
    await updateOrgTier(user.orgId, "free");

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/setup",
      { method: "POST" },
    );
    const response = await POST(request);

    expect(response.status).toBe(403);
    const data = await response.json();
    expect((data as Record<string, string>).error).toContain("Team plan");
  });

  it("should return 409 when phone is already configured", async () => {
    const user = await context.setupUser();
    await updateOrgTier(user.orgId, "team");

    // Pre-configure agentphone to simulate already-set-up state
    await createPhoneOrg(user.orgId);

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/setup",
      { method: "POST" },
    );
    const response = await POST(request);

    expect(response.status).toBe(409);
    const data = await response.json();
    expect((data as Record<string, string>).error).toContain(
      "already configured",
    );
  });

  it("should provision agent, number, and webhook on success", async () => {
    const user = await context.setupUser();
    await updateOrgTier(user.orgId, "team");

    const mockAgentId = "ap-agent-new-123";
    const mockNumberId = "ap-num-new-456";
    const mockPhoneNumber = "+18005550123";

    server.use(
      // Create agent
      http.post(`${AGENTPHONE_BASE}/v1/agents`, () => {
        return HttpResponse.json({ id: mockAgentId, name: "Zero" });
      }),
      // Create number
      http.post(`${AGENTPHONE_BASE}/v1/numbers`, () => {
        return HttpResponse.json({
          id: mockNumberId,
          phoneNumber: mockPhoneNumber,
        });
      }),
      // Attach number to agent
      http.post(`${AGENTPHONE_BASE}/v1/agents/${mockAgentId}/numbers`, () => {
        return HttpResponse.json({ success: true });
      }),
      // Configure webhook
      http.post(`${AGENTPHONE_BASE}/v1/agents/${mockAgentId}/webhook`, () => {
        return HttpResponse.json({
          url: "https://test.vm0.ai/api/zero/phone/webhook",
        });
      }),
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/setup",
      { method: "POST" },
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect((data as Record<string, string>).phoneNumber).toBe(mockPhoneNumber);
    expect((data as Record<string, string>).agentId).toBe(mockAgentId);

    // Verify org_metadata was updated with the new agentphone IDs
    const config = await getOrgAgentphoneConfig(user.orgId);
    expect(config.agentphoneAgentId).toBe(mockAgentId);
    expect(config.agentphoneNumberId).toBe(mockNumberId);
    expect(config.agentphoneNumber).toBe(mockPhoneNumber);
  });
});
