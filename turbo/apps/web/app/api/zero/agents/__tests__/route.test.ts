import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { GET, PUT } from "../[name]/route";
import {
  GET as getInstructions,
  PUT as putInstructions,
} from "../[name]/instructions/route";
import {
  createTestRequest,
  createTestCliToken,
  seedTestSkill,
  clearSkillsData,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";

const context = testContext();

let testCliToken: string;
let testOrgSlug: string;

function postAgent(
  body: Record<string, unknown>,
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return POST(
    createTestRequest(`http://localhost:3000/api/zero/agents${orgParam}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

function getAgent(name: string, token: string, orgSlug?: string) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return GET(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${name}${orgParam}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

function putAgent(
  name: string,
  body: Record<string, unknown>,
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return PUT(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${name}${orgParam}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

function getAgentInstructions(name: string, token: string, orgSlug?: string) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return getInstructions(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${name}/instructions${orgParam}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

function putAgentInstructions(
  name: string,
  body: { content: string },
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return putInstructions(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${name}/instructions${orgParam}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

describe("Zero Agents API", () => {
  beforeEach(async () => {
    context.setupMocks();
    await clearSkillsData();
    const user = await context.setupUser();
    testCliToken = await createTestCliToken(user.userId);
    testOrgSlug = `org-${user.userId.slice(-8)}`;
  });

  describe("POST /api/zero/agents", () => {
    it("should create an agent with no connectors", async () => {
      const response = await postAgent(
        { connectors: [] },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.name).toBeTruthy();
      expect(data.agentComposeId).toBeTruthy();
      expect(data.connectors).toStrictEqual([]);
      expect(data.description).toBeNull();
      expect(data.displayName).toBeNull();
      expect(data.sound).toBeNull();
    });

    it("should create an agent with metadata", async () => {
      const response = await postAgent(
        {
          connectors: [],
          displayName: "My Agent",
          description: "A helpful agent",
          sound: "professional",
        },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.displayName).toBe("My Agent");
      expect(data.description).toBe("A helpful agent");
      expect(data.sound).toBe("professional");
    });

    it("should create an agent with cached connectors", async () => {
      await seedTestSkill({
        url: "https://github.com/vm0-ai/vm0-skills/tree/main/slack",
        name: "slack",
        fullPath: "vm0-ai/vm0-skills/tree/main/slack",
        frontmatter: {
          name: "Slack",
          description: "Slack integration",
          vm0_secrets: ["SLACK_BOT_TOKEN"],
          vm0_vars: [],
        },
      });

      const response = await postAgent(
        { connectors: ["slack"] },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.connectors).toStrictEqual(["slack"]);
    });

    it("should return 422 when connector skills are not cached", async () => {
      const response = await postAgent(
        { connectors: ["uncached-skill"] },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(422);
      const data = await response.json();
      expect(data.error.code).toBe("UNPROCESSABLE_ENTITY");
    });

    it("should return 401 without auth", async () => {
      const { mockClerk } = await import(
        "../../../../../src/__tests__/clerk-mock"
      );
      mockClerk({ userId: null });

      const response = await postAgent({ connectors: [] }, "no-token");
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/zero/agents/:name", () => {
    it("should return created agent", async () => {
      // Create an agent first
      const createResponse = await postAgent(
        {
          connectors: [],
          displayName: "Test Agent",
          description: "Test description",
          sound: "friendly",
        },
        testCliToken,
        testOrgSlug,
      );

      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();

      // Get the agent
      const response = await getAgent(created.name, testCliToken, testOrgSlug);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe(created.name);
      expect(data.agentComposeId).toBe(created.agentComposeId);
      expect(data.displayName).toBe("Test Agent");
      expect(data.description).toBe("Test description");
      expect(data.sound).toBe("friendly");
    });

    it("should return 404 for unknown agent", async () => {
      const response = await getAgent(
        "nonexistent-agent",
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });

  describe("PUT /api/zero/agents/:name", () => {
    it("should update agent connectors and metadata", async () => {
      // Create an agent first
      const createResponse = await postAgent(
        { connectors: [], displayName: "Original" },
        testCliToken,
        testOrgSlug,
      );
      const created = await createResponse.json();

      // Update the agent
      const response = await putAgent(
        created.name,
        {
          connectors: [],
          displayName: "Updated Name",
          description: "Updated description",
          sound: "casual",
        },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.displayName).toBe("Updated Name");
      expect(data.description).toBe("Updated description");
      expect(data.sound).toBe("casual");
    });

    it("should return 404 for unknown agent", async () => {
      const response = await putAgent(
        "nonexistent-agent",
        { connectors: [] },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/zero/agents/:name/instructions", () => {
    it("should return null content when no instructions uploaded", async () => {
      const createResponse = await postAgent(
        { connectors: [] },
        testCliToken,
        testOrgSlug,
      );
      const created = await createResponse.json();

      const response = await getAgentInstructions(
        created.name,
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.content).toBeNull();
    });

    it("should return 404 for unknown agent", async () => {
      const response = await getAgentInstructions(
        "nonexistent-agent",
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(404);
    });
  });

  describe("PUT /api/zero/agents/:name/instructions", () => {
    it("should update instructions and return agent response", async () => {
      const createResponse = await postAgent(
        { connectors: [] },
        testCliToken,
        testOrgSlug,
      );
      const created = await createResponse.json();

      const response = await putAgentInstructions(
        created.name,
        { content: "# Updated Instructions\nBe helpful." },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe(created.name);
      expect(data.agentComposeId).toBeTruthy();

      // Verify S3 upload was called for instructions
      expect(context.mocks.s3.putS3Object).toHaveBeenCalled();
    });

    it("should return 404 for unknown agent", async () => {
      const response = await putAgentInstructions(
        "nonexistent-agent",
        { content: "# Instructions" },
        testCliToken,
        testOrgSlug,
      );

      expect(response.status).toBe(404);
    });
  });
});
