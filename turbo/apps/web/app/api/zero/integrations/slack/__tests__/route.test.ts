import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { GET, DELETE } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { createTestOrg } from "../../../../../../src/__tests__/api-test-helpers";
import {
  createTestSlackOrgInstallation,
  createTestSlackOrgConnection,
} from "../../../../../../src/__tests__/db-test-seeders/slack";
import {
  findTestSlackOrgConnection,
  findTestSlackOrgInstallation,
} from "../../../../../../src/__tests__/db-test-assertions/slack";
import { SLACK_BOT_SCOPES } from "../../../../../../src/lib/zero/slack-org/scopes";

const context = testContext();

async function givenOrgSlackSetup(
  options: {
    isAdmin?: boolean;
    withConnection?: boolean;
    botScopes?: string | null;
  } = {},
) {
  const { isAdmin = false, withConnection = true, botScopes } = options;
  const user = await context.setupUser();
  const org = await createTestOrg(uniqueId("org"));

  const { slackWorkspaceId } = await createTestSlackOrgInstallation({
    orgId: org.id,
    botScopes,
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

describe("/api/zero/integrations/slack", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns isConnected=false when user has no connection", async () => {
      await givenOrgSlackSetup({ withConnection: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isConnected).toBe(false);
    });

    it("returns workspace info for connected user", async () => {
      await givenOrgSlackSetup({ withConnection: true });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack",
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
        "http://localhost:3000/api/zero/integrations/slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isAdmin).toBe(true);
    });

    it("returns isAdmin=false for non-admin members", async () => {
      await givenOrgSlackSetup({ isAdmin: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isAdmin).toBe(false);
    });

    it("returns environment info when connected", async () => {
      await givenOrgSlackSetup();

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack",
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
        "http://localhost:3000/api/zero/integrations/slack",
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
        "http://localhost:3000/api/zero/integrations/slack",
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
        "http://localhost:3000/api/zero/integrations/slack",
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
        "http://localhost:3000/api/zero/integrations/slack?action=uninstall",
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
        "http://localhost:3000/api/zero/integrations/slack?action=uninstall",
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
        "http://localhost:3000/api/zero/integrations/slack?action=uninstall",
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
        "http://localhost:3000/api/zero/integrations/slack?action=uninstall",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      expect(response.status).toBe(200);

      // Verify App Home was published (views.publish called)
      expect(mockClient.views.publish).toHaveBeenCalled();

      // Verify the view shows "not installed" state by checking for the
      // "Open Zero Settings" action button (only present when isInstalled=false)
      const publishCall = mockClient.views.publish.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(publishCall).toBeDefined();
      const view = publishCall!.view as {
        blocks: Array<{
          type?: string;
          elements?: Array<{ action_id?: string }>;
        }>;
      };
      const hasSettingsAction = view.blocks.some((b) => {
        return (
          b.type === "actions" &&
          b.elements?.some((e) => {
            return e.action_id === "home_open_settings";
          })
        );
      });
      expect(hasSettingsAction).toBe(true);

      // Verify installation was deleted after publishing
      const installation = await findTestSlackOrgInstallation(workspaceId);
      expect(installation).toBeUndefined();
    });
  });

  describe("GET scope mismatch detection", () => {
    it("returns scopeMismatch=false when installation has all required scopes", async () => {
      const fullScopes = JSON.stringify([...SLACK_BOT_SCOPES]);
      await givenOrgSlackSetup({ isAdmin: true, botScopes: fullScopes });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.scopeMismatch).toBe(false);
      expect(data.reinstallUrl).toBeNull();
    });

    it("returns scopeMismatch=true when installation is missing scopes", async () => {
      const partialScopes = JSON.stringify(["chat:write", "channels:read"]);
      await givenOrgSlackSetup({ isAdmin: true, botScopes: partialScopes });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.scopeMismatch).toBe(true);
      expect(data.reinstallUrl).toContain("/api/zero/slack/oauth/install");
      expect(data.reinstallUrl).toContain("reinstall=1");
    });

    it("treats null bot_scopes as mismatch (requires reinstall)", async () => {
      await givenOrgSlackSetup({ isAdmin: true, botScopes: null });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.scopeMismatch).toBe(true);
    });

    it("does not expose scopeMismatch to non-admin users", async () => {
      const partialScopes = JSON.stringify(["chat:write"]);
      await givenOrgSlackSetup({ isAdmin: false, botScopes: partialScopes });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.scopeMismatch).toBeUndefined();
      expect(data.reinstallUrl).toBeUndefined();
    });

    it("returns scopeMismatch for admin when user is not connected", async () => {
      const partialScopes = JSON.stringify(["chat:write"]);
      await givenOrgSlackSetup({
        isAdmin: true,
        withConnection: false,
        botScopes: partialScopes,
      });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isConnected).toBe(false);
      expect(data.scopeMismatch).toBe(true);
      expect(data.reinstallUrl).toContain("reinstall=1");
    });
  });
});
