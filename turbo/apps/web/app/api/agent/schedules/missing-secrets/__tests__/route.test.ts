import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSecret,
  insertOrgMembersCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../src/lib/auth/sandbox-token";

const context = testContext();

describe("GET /api/agent/schedules/missing-secrets", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules/missing-secrets",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should report missing secrets for own agent", async () => {
    const agentName = uniqueId("missing-agent");
    await createTestCompose(agentName, {
      overrides: {
        environment: {
          MY_SECRET: "${{ secrets.MY_SECRET }}",
        },
      },
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules/missing-secrets",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const agent = data.agents.find(
      (a: { agentName: string }) => a.agentName === agentName,
    );
    expect(agent).toBeDefined();
    expect(agent.missingSecrets).toContain("MY_SECRET");
  });

  it("should not report configured secrets as missing", async () => {
    const secretName = `TEST_SECRET_${Date.now()}`;
    const agentName = uniqueId("configured-agent");
    await createTestCompose(agentName, {
      overrides: {
        environment: {
          [secretName]: `\${{ secrets.${secretName} }}`,
        },
      },
    });

    // Configure the secret
    await createTestSecret(secretName, "secret-value");

    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules/missing-secrets",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const agent = data.agents.find(
      (a: { agentName: string }) => a.agentName === agentName,
    );
    // Agent should not appear since its only secret is configured
    expect(agent).toBeUndefined();
  });

  it("should not report api-token-only connector secret as missing", async () => {
    // Productlane has empty environmentMapping — the secret is stored as a
    // user secret via the api-token connector flow, so it should still be
    // found by the missing-secrets check.
    const agentName = uniqueId("productlane-agent");
    await createTestCompose(agentName, {
      overrides: {
        environment: {
          PRODUCTLANE_TOKEN: "${{ secrets.PRODUCTLANE_TOKEN }}",
        },
      },
    });

    await createTestSecret("PRODUCTLANE_TOKEN", "pl_test_value");

    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules/missing-secrets",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const agent = data.agents.find(
      (a: { agentName: string }) => a.agentName === agentName,
    );
    // Agent should not appear since its secret is configured
    expect(agent).toBeUndefined();
  });
});

describe("GET /api/agent/schedules/missing-secrets - Sandbox Token Auth", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should accept sandbox token with schedule:read capability", async () => {
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
    });
    mockClerk({ userId: null });
    const token = await generateSandboxToken(user.userId, "run-123", [
      "schedule:read",
    ]);

    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules/missing-secrets",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
  });

  it("should reject sandbox token without schedule:read capability", async () => {
    mockClerk({ userId: null });
    const token = await generateSandboxToken(user.userId, "run-123", [
      "storage:read",
    ]);

    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules/missing-secrets",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const response = await GET(request);

    expect(response.status).toBe(403);
  });
});
