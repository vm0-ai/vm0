import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestPermission,
  createTestSecret,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import {
  mockClerk,
  MOCK_USER_EMAIL,
} from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/agent/schedules/missing-secrets", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
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

  it("should report missing secrets for email-shared agent", async () => {
    // Owner creates agent with secret refs and shares it
    const owner = await context.setupUser({ prefix: "ms-owner" });
    const agentName = uniqueId("shared-missing");
    const { composeId } = await createTestCompose(agentName, {
      overrides: {
        environment: {
          SHARED_KEY: "${{ secrets.SHARED_KEY }}",
        },
      },
    });
    await createTestPermission(composeId, "email", MOCK_USER_EMAIL);

    const ownerSuffix = owner.userId.replace("ms-owner-", "");
    const ownerScopeSlug = `scope-${ownerSuffix}`;

    // Switch to recipient — they don't have SHARED_KEY configured
    mockClerk({ userId: user.userId });
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules/missing-secrets",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const agent = data.agents.find(
      (a: { agentName: string }) =>
        a.agentName === `${ownerScopeSlug}/${agentName}`,
    );
    expect(agent).toBeDefined();
    expect(agent.missingSecrets).toContain("SHARED_KEY");
  });
});
