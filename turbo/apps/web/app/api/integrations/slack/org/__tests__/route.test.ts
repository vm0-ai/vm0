import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { GET, DELETE } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import {
  createTestOrg,
  createTestSlackOrgInstallation,
  createTestSlackOrgConnection,
  findTestSlackOrgConnection,
  findTestSlackOrgInstallation,
} from "../../../../../../src/__tests__/api-test-helpers";

const context = testContext();

async function givenOrgSlackSetup(
  options: {
    isAdmin?: boolean;
    withConnection?: boolean;
  } = {},
) {
  const { isAdmin = false, withConnection = true } = options;
  const user = await context.setupUser();
  const org = await createTestOrg(uniqueId("org"));

  const { slackWorkspaceId } = await createTestSlackOrgInstallation({
    orgId: org.id,
  });

  // Set up the mock with orgId so resolveOrg picks the correct org
  mockClerk({
    userId: user.userId,
    orgId: org.id,
    orgRole: isAdmin ? "org:admin" : "org:member",
  });

  let slackUserId = "";
  if (withConnection) {
    const connection = await createTestSlackOrgConnection({
      slackWorkspaceId,
      vm0UserId: user.userId,
    });
    slackUserId = connection.slackUserId;
  }

  return { user, org, workspaceId: slackWorkspaceId, slackUserId };
}

describe("/api/integrations/slack/org", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/org",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns isConnected=false when user has no connection", async () => {
      await givenOrgSlackSetup({ withConnection: false });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/org",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isConnected).toBe(false);
    });

    it("returns workspace info for connected user", async () => {
      await givenOrgSlackSetup({ withConnection: true });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/org",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isConnected).toBe(true);
      expect(data.workspaceName).toBe("Test Org Workspace");
    });

    it("returns isAdmin=true for admin members", async () => {
      await givenOrgSlackSetup({ isAdmin: true });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/org",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isAdmin).toBe(true);
    });

    it("returns isAdmin=false for non-admin members", async () => {
      await givenOrgSlackSetup({ isAdmin: false });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/org",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isAdmin).toBe(false);
    });

    it("returns environment info when connected", async () => {
      await givenOrgSlackSetup();

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/org",
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

  describe("DELETE", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/org",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 404 when user has no connection", async () => {
      await givenOrgSlackSetup({ withConnection: false });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/org",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("deletes connection and returns ok", async () => {
      const { slackUserId, workspaceId } = await givenOrgSlackSetup();

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/org",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify connection was deleted
      const connection = await findTestSlackOrgConnection(
        slackUserId,
        workspaceId,
      );
      expect(connection).toBeUndefined();
    });
  });

  describe("DELETE ?action=uninstall", () => {
    it("returns 403 when non-admin tries to uninstall", async () => {
      await givenOrgSlackSetup({ isAdmin: false });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/org?action=uninstall",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("returns 404 when no installation exists", async () => {
      const user = await context.setupUser();
      const org = await createTestOrg(uniqueId("org"));
      mockClerk({
        userId: user.userId,
        orgId: org.id,
        orgRole: "org:admin",
      });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/org?action=uninstall",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("deletes installation and all connections", async () => {
      const { workspaceId, slackUserId } = await givenOrgSlackSetup({
        isAdmin: true,
      });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/org?action=uninstall",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify installation was deleted
      const installation = await findTestSlackOrgInstallation(workspaceId);
      expect(installation).toBeUndefined();

      // Verify connection was deleted
      const connection = await findTestSlackOrgConnection(
        slackUserId,
        workspaceId,
      );
      expect(connection).toBeUndefined();
    });

    it("publishes uninstalled App Home for connected users before deleting", async () => {
      const { workspaceId } = await givenOrgSlackSetup({ isAdmin: true });

      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.views.publish.mockClear();

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/org?action=uninstall",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      expect(response.status).toBe(200);

      // Verify App Home was published (views.publish called)
      expect(mockClient.views.publish).toHaveBeenCalled();

      // Verify the view shows "not installed" state
      const publishCall = mockClient.views.publish.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(publishCall).toBeDefined();
      const view = publishCall!.view as {
        blocks: Array<{ text?: { text?: string } }>;
      };
      const blockTexts = view.blocks.map((b) => b.text?.text ?? "").join(" ");
      expect(blockTexts).toContain("not installed");

      // Verify installation was deleted after publishing
      const installation = await findTestSlackOrgInstallation(workspaceId);
      expect(installation).toBeUndefined();
    });
  });
});
