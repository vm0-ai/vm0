import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../../app/api/zero/onboarding/setup/route";
import { GET as getOnboardingStatus } from "../../app/api/zero/onboarding/status/route";
import { GET as listAgents } from "../../app/api/zero/agents/route";
import { GET as getUserConnectors } from "../../app/api/zero/agents/[id]/user-connectors/route";
import { GET as listModelProviders } from "../../app/api/zero/model-providers/route";
import { createTestRequest, getOrgDefaultAgent } from "./api-test-helpers";
import { testContext } from "./test-helpers";
import { mockClerk } from "./clerk-mock";

const context = testContext();

const BASE = "http://localhost:3000/api/zero";

function postSetup(body: Record<string, unknown>) {
  return POST(
    createTestRequest(`${BASE}/onboarding/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/zero/onboarding/setup", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should create agent and complete onboarding in a single call", async () => {
    const { userId, orgId } = await context.setupUser();
    mockClerk({ userId, orgId, orgRole: "org:admin" });

    const response = await postSetup({
      displayName: "My Assistant",
      sound: "professional",
      avatarUrl: "preset:0",
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.agentId).toBeTruthy();

    // Verify agent was created via list API
    const agentListRes = await listAgents(createTestRequest(`${BASE}/agents`));
    const agentList = await agentListRes.json();
    const agent = agentList.find((a: { agentId: string }) => {
      return a.agentId === data.agentId;
    });
    expect(agent).toBeDefined();
    expect(agent.displayName).toBe("My Assistant");
    expect(agent.sound).toBe("professional");
    expect(agent.avatarUrl).toBe("preset:0");

    // Verify default agent was set
    const defaultAgent = await getOrgDefaultAgent(orgId);
    expect(defaultAgent).toBe(data.agentId);

    // Verify onboarding status reports complete
    const statusRes = await getOnboardingStatus(
      createTestRequest(`${BASE}/onboarding/status`),
    );
    const status = await statusRes.json();
    expect(status.needsOnboarding).toBe(false);
    expect(status.hasDefaultAgent).toBe(true);
  });

  it("should be idempotent — return same agentId on second call", async () => {
    const { userId, orgId } = await context.setupUser();
    mockClerk({ userId, orgId, orgRole: "org:admin" });

    const first = await postSetup({ displayName: "Zero" });
    expect(first.status).toBe(200);
    const firstData = await first.json();

    const second = await postSetup({ displayName: "Different Name" });
    expect(second.status).toBe(200);
    const secondData = await second.json();

    expect(secondData.agentId).toBe(firstData.agentId);
  });

  it("should set user connectors when provided", async () => {
    const { userId, orgId } = await context.setupUser();
    mockClerk({ userId, orgId, orgRole: "org:admin" });

    const response = await postSetup({
      displayName: "Zero",
      selectedConnectors: ["slack", "github"],
    });
    expect(response.status).toBe(200);
    const data = await response.json();

    // Verify connectors via GET API
    const connRes = await getUserConnectors(
      createTestRequest(`${BASE}/agents/${data.agentId}/user-connectors`),
    );
    expect(connRes.status).toBe(200);
    const connData = await connRes.json();
    expect(connData.enabledTypes.sort()).toEqual(["github", "slack"]);
  });

  it("should create vm0 model provider", async () => {
    const { userId, orgId } = await context.setupUser();
    mockClerk({ userId, orgId, orgRole: "org:admin" });

    const response = await postSetup({ displayName: "Zero" });
    expect(response.status).toBe(200);

    // Verify model provider via list API
    const provRes = await listModelProviders(
      createTestRequest(`${BASE}/model-providers`),
    );
    const provData = await provRes.json();
    const vm0Provider = provData.modelProviders.find((p: { type: string }) => {
      return p.type === "vm0";
    });
    expect(vm0Provider).toBeDefined();
    expect(vm0Provider.selectedModel).toBe("claude-sonnet-4.6");
  });

  it("should work with minimal payload (displayName only)", async () => {
    const { userId, orgId } = await context.setupUser();
    mockClerk({ userId, orgId, orgRole: "org:admin" });

    const response = await postSetup({ displayName: "Zero" });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.agentId).toBeTruthy();
  });

  it("should return 401 for unauthenticated requests", async () => {
    mockClerk({ userId: null });

    const response = await postSetup({ displayName: "Zero" });
    expect(response.status).toBe(401);
  });

  it("should return 403 for non-admin members", async () => {
    const { userId, orgId } = await context.setupUser();
    mockClerk({ userId, orgId, orgRole: "org:member" });

    const response = await postSetup({ displayName: "Zero" });
    expect(response.status).toBe(403);
  });
});
