import { describe, it, expect, beforeEach } from "vitest";
import { GET, DELETE, PATCH } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  setDefaultAgentByComposeId,
  insertTestGitHubInstallation,
  insertTestGitHubInstallationWithAdmin,
  insertTestGitHubUserLink,
  findTestGitHubInstallationById,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("/api/integrations/github", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET /api/integrations/github", () => {
    it("should return 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
      );
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it("should return 404 with installUrl when no installation exists", async () => {
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      const org = await createTestOrg(uniqueId("gh-org"));
      const { composeId } = await createTestCompose(uniqueId("gh-agent"));
      await setDefaultAgentByComposeId(org.id, composeId);

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {},
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
      expect(data.installUrl).toContain(`composeId=${composeId}`);
    });

    it("should return installation data when installed", async () => {
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      await createTestOrg(uniqueId("gh-org"));
      const agentName = uniqueId("gh-agent");
      const { composeId } = await createTestCompose(agentName);

      await insertTestGitHubInstallationWithAdmin(composeId, userId);

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {},
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.installation).toBeDefined();
      expect(data.installation.installationId).toBeTruthy();
      expect(data.agent).toBeDefined();
      expect(data.agent.name).toBe(agentName);
    });

    it("should return environment data in response", async () => {
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      await createTestOrg(uniqueId("gh-org"));
      const { composeId } = await createTestCompose(uniqueId("gh-agent"));

      await insertTestGitHubInstallationWithAdmin(composeId, userId);

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {},
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.environment).toBeDefined();
      expect(data.environment.requiredSecrets).toBeDefined();
      expect(data.environment.requiredVars).toBeDefined();
      expect(data.environment.missingSecrets).toBeDefined();
      expect(data.environment.missingVars).toBeDefined();
    });
  });

  describe("DELETE /api/integrations/github", () => {
    it("should return 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        { method: "DELETE" },
      );
      const response = await DELETE(request);

      expect(response.status).toBe(401);
    });

    it("should return 404 when no installation exists", async () => {
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      await createTestOrg(uniqueId("gh-org"));

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {
          method: "DELETE",
        },
      );
      const response = await DELETE(request);

      expect(response.status).toBe(404);
    });

    it("should delete installation and return ok", async () => {
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      await createTestOrg(uniqueId("gh-org"));
      const { composeId } = await createTestCompose(uniqueId("gh-agent"));

      const { installation } = await insertTestGitHubInstallationWithAdmin(
        composeId,
        userId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {
          method: "DELETE",
        },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify installation was deleted
      const row = await findTestGitHubInstallationById(installation.id);
      expect(row).toBeUndefined();
    });

    it("should return 403 when adminGithubUserId is null", async () => {
      // Create installation WITHOUT setting an admin (simulates org install where admin is unset)
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      await createTestOrg(uniqueId("gh-org"));
      const { composeId } = await createTestCompose(uniqueId("gh-agent"));

      const installation = await insertTestGitHubInstallation(composeId);
      // Link user but leave adminGithubUserId as null (default)
      await insertTestGitHubUserLink(
        uniqueId("gh-uid"),
        installation.id,
        userId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {
          method: "DELETE",
        },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");

      // Verify installation was NOT deleted
      const row = await findTestGitHubInstallationById(installation.id);
      expect(row).toBeDefined();
    });

    it("should return 403 when non-admin attempts to delete", async () => {
      // Create installation with admin user
      const adminUserId = uniqueId("admin-user");
      mockClerk({ userId: adminUserId });
      await createTestOrg(uniqueId("gh-org"));
      const { composeId } = await createTestCompose(uniqueId("gh-agent"));
      const { installation } = await insertTestGitHubInstallationWithAdmin(
        composeId,
        adminUserId,
      );

      // Create a non-admin user linked to the same installation
      const nonAdminUserId = uniqueId("nonadmin-user");
      mockClerk({ userId: nonAdminUserId });
      await createTestOrg(uniqueId("gh-org"));
      await insertTestGitHubUserLink(
        uniqueId("gh-other-uid"),
        installation.id,
        nonAdminUserId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {
          method: "DELETE",
        },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");

      // Verify installation was NOT deleted
      const row = await findTestGitHubInstallationById(installation.id);
      expect(row).toBeDefined();
    });
  });

  describe("PATCH /api/integrations/github", () => {
    it("should return 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: "test-agent" }),
        },
      );
      const response = await PATCH(request);

      expect(response.status).toBe(401);
    });

    it("should return 400 when agentName is missing", async () => {
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      await createTestOrg(uniqueId("gh-org"));
      const { composeId } = await createTestCompose(uniqueId("gh-agent"));
      await insertTestGitHubInstallationWithAdmin(composeId, userId);

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("should return 404 when no installation exists", async () => {
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      await createTestOrg(uniqueId("gh-org"));

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ agentName: "some-agent" }),
        },
      );
      const response = await PATCH(request);

      expect(response.status).toBe(404);
    });

    it("should return 403 when adminGithubUserId is null", async () => {
      // Create installation WITHOUT setting an admin (simulates org install where admin is unset)
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      await createTestOrg(uniqueId("gh-org"));
      const { composeId } = await createTestCompose(uniqueId("gh-agent"));

      const installation = await insertTestGitHubInstallation(composeId);
      // Link user but leave adminGithubUserId as null (default)
      await insertTestGitHubUserLink(
        uniqueId("gh-uid"),
        installation.id,
        userId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ agentName: "some-agent" }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("should return 403 when non-admin attempts to update", async () => {
      // Create installation with admin user
      const adminUserId = uniqueId("admin-user");
      mockClerk({ userId: adminUserId });
      await createTestOrg(uniqueId("gh-org"));
      const { composeId } = await createTestCompose(uniqueId("gh-agent"));
      const { installation } = await insertTestGitHubInstallationWithAdmin(
        composeId,
        adminUserId,
      );

      // Create a non-admin user linked to the same installation
      const nonAdminUserId = uniqueId("nonadmin-user");
      mockClerk({ userId: nonAdminUserId });
      await createTestOrg(uniqueId("gh-org"));
      await insertTestGitHubUserLink(
        uniqueId("gh-other-uid"),
        installation.id,
        nonAdminUserId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ agentName: "some-agent" }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("should return 404 when agent does not exist", async () => {
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      await createTestOrg(uniqueId("gh-org"));
      const { composeId } = await createTestCompose(uniqueId("gh-agent"));
      await insertTestGitHubInstallationWithAdmin(composeId, userId);

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ agentName: "nonexistent-agent" }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should update default agent successfully", async () => {
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      await createTestOrg(uniqueId("gh-org"));
      const { composeId } = await createTestCompose(uniqueId("gh-agent"));
      await insertTestGitHubInstallationWithAdmin(composeId, userId);

      // Create a new agent to switch to
      const newAgentName = uniqueId("new-agent");
      await createTestCompose(newAgentName);

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ agentName: newAgentName }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify the agent was updated by fetching the integration
      const getResponse = await GET(
        createTestRequest("http://localhost:3000/api/integrations/github", {}),
      );
      const getData = await getResponse.json();

      expect(getData.agent.name).toBe(newAgentName);
    });
  });
});
