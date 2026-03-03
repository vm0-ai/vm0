import { describe, it, expect, beforeEach } from "vitest";
import { GET, DELETE } from "../route";
import {
  createTestRequest,
  createTestScope,
  createTestCompose,
  insertTestGitHubInstallation,
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
      await createTestScope(uniqueId("gh-scope"));

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        { headers: { Authorization: "Bearer test-token" } },
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
      expect(data.installUrl).toBeDefined();
    });

    it("should return installation data when installed", async () => {
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      await createTestScope(uniqueId("gh-scope"));
      const { composeId } = await createTestCompose("gh-agent");

      await insertTestGitHubInstallation(userId, composeId);

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        { headers: { Authorization: "Bearer test-token" } },
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.installation).toBeDefined();
      expect(data.installation.installationId).toBeTruthy();
      expect(data.agent).toBeDefined();
      expect(data.agent.name).toBe("gh-agent");
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
      await createTestScope(uniqueId("gh-scope"));

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {
          method: "DELETE",
          headers: { Authorization: "Bearer test-token" },
        },
      );
      const response = await DELETE(request);

      expect(response.status).toBe(404);
    });

    it("should delete installation and return ok", async () => {
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      await createTestScope(uniqueId("gh-scope"));
      const { composeId } = await createTestCompose("gh-agent");

      const installation = await insertTestGitHubInstallation(
        userId,
        composeId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/integrations/github",
        {
          method: "DELETE",
          headers: { Authorization: "Bearer test-token" },
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
  });
});
