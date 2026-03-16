import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/agent/required-env", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/required-env",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return required secrets for own agent", async () => {
    const agentName = uniqueId("env-agent");
    await createTestCompose(agentName, {
      overrides: {
        environment: {
          MY_KEY: "${{ secrets.MY_KEY }}",
          SOME_VAR: "${{ vars.SOME_VAR }}",
        },
      },
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/required-env",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const agent = data.agents.find(
      (a: { agentName: string }) => a.agentName === agentName,
    );
    expect(agent).toBeDefined();
    expect(agent.requiredSecrets).toContain("MY_KEY");
    expect(agent.requiredVariables).toContain("SOME_VAR");
  });

  it("should skip agents with no environment block", async () => {
    const agentName = uniqueId("no-env");
    await createTestCompose(agentName, { noEnvironmentBlock: true });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/required-env",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const agent = data.agents.find(
      (a: { agentName: string }) => a.agentName === agentName,
    );
    expect(agent).toBeUndefined();
  });
});
