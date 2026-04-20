import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import {
  createTestOrg,
  createTestRequest,
  insertOrgCacheEntry,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  createTestSlackOrgInstallation,
  createTestSlackOrgConnection,
} from "../../../../../../../src/__tests__/db-test-seeders/slack";
import { findTestSlackOrgConnection } from "../../../../../../../src/__tests__/db-test-assertions/slack";

const context = testContext();

/**
 * Helper — set up an org with a Slack installation already bound to it.
 * Returns identifiers needed for connect tests.
 */
async function givenBoundWorkspace(opts?: { isAdmin?: boolean }) {
  const { isAdmin = true } = opts ?? {};
  const user = await context.setupUser();
  const org = await createTestOrg(uniqueId("org"));

  const { slackWorkspaceId } = await createTestSlackOrgInstallation({
    orgId: org.id,
  });

  mockClerk({
    userId: user.userId,
    orgId: org.id,
    orgRole: isAdmin ? "org:admin" : "org:member",
  });

  return { user, org, workspaceId: slackWorkspaceId };
}

/**
 * Helper — set up an unbound Slack installation (no orgId).
 */
async function givenUnboundWorkspace(opts?: { isAdmin?: boolean }) {
  const { isAdmin = true } = opts ?? {};
  const user = await context.setupUser();
  const org = await createTestOrg(uniqueId("org"));

  const { slackWorkspaceId } = await createTestSlackOrgInstallation({
    orgId: null,
  });

  mockClerk({
    userId: user.userId,
    orgId: org.id,
    orgRole: isAdmin ? "org:admin" : "org:member",
  });

  return { user, org, workspaceId: slackWorkspaceId };
}

describe("/api/zero/integrations/slack/connect", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  // ─── GET (check connection status) ───────────────────────────────────

  describe("GET", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack/connect",
      );
      const response = await GET(request);
      const data = (await response.json()) as { error: { code: string } };

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns isConnected=false when user has no connection", async () => {
      await givenBoundWorkspace();

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack/connect",
      );
      const response = await GET(request);
      const data = (await response.json()) as { isConnected: boolean };

      expect(response.status).toBe(200);
      expect(data.isConnected).toBe(false);
    });

    it("returns isConnected=true with workspace info when connected", async () => {
      const { user, workspaceId } = await givenBoundWorkspace();

      await createTestSlackOrgConnection({
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack/connect",
      );
      const response = await GET(request);
      const data = (await response.json()) as {
        isConnected: boolean;
        workspaceName: string;
      };

      expect(response.status).toBe(200);
      expect(data.isConnected).toBe(true);
      expect(data.workspaceName).toBeDefined();
    });

    it("returns isAdmin=true for admin users", async () => {
      await givenBoundWorkspace({ isAdmin: true });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack/connect",
      );
      const response = await GET(request);
      const data = (await response.json()) as { isAdmin: boolean };

      expect(data.isAdmin).toBe(true);
    });

    it("returns isAdmin=false for member users", async () => {
      await givenBoundWorkspace({ isAdmin: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/slack/connect",
      );
      const response = await GET(request);
      const data = (await response.json()) as { isAdmin: boolean };

      expect(data.isAdmin).toBe(false);
    });
  });

  // ─── POST (connect user to workspace) ────────────────────────────────

  describe("POST", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/zero/integrations/slack/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: "T-fake",
            slackUserId: "U-fake",
          }),
        },
      );
      const response = await POST(request);
      const data = (await response.json()) as { error: { code: string } };

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 400 when body is missing required fields", async () => {
      await givenBoundWorkspace();

      const request = createTestRequest(
        "http://localhost:3000/api/zero/integrations/slack/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const response = await POST(request);
      const data = (await response.json()) as { error: { code: string } };

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("returns 400 when body is not valid JSON", async () => {
      await givenBoundWorkspace();

      const request = createTestRequest(
        "http://localhost:3000/api/zero/integrations/slack/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not-json",
        },
      );
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it("returns 404 when workspace does not exist", async () => {
      await givenBoundWorkspace();

      const request = createTestRequest(
        "http://localhost:3000/api/zero/integrations/slack/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: "T-nonexistent",
            slackUserId: "U-someone",
          }),
        },
      );
      const response = await POST(request);
      const data = (await response.json()) as { error: { code: string } };

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("member connects successfully to a bound workspace", async () => {
      const { user, workspaceId } = await givenBoundWorkspace({
        isAdmin: false,
      });
      const slackUserId = `U-${uniqueId("slack")}`;

      const request = createTestRequest(
        "http://localhost:3000/api/zero/integrations/slack/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, slackUserId }),
        },
      );
      const response = await POST(request);
      const data = (await response.json()) as {
        success: boolean;
        role: string;
      };

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.role).toBe("member");

      // Verify connection was created
      const connection = await findTestSlackOrgConnection(
        slackUserId,
        workspaceId,
      );
      expect(connection).toBeDefined();
      expect(connection!.vm0UserId).toBe(user.userId);
      expect(connection!.slackWorkspaceId).toBe(workspaceId);
    });

    it("admin connects successfully to a bound workspace", async () => {
      const { workspaceId } = await givenBoundWorkspace({ isAdmin: true });
      const slackUserId = `U-${uniqueId("slack")}`;

      const request = createTestRequest(
        "http://localhost:3000/api/zero/integrations/slack/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, slackUserId }),
        },
      );
      const response = await POST(request);
      const data = (await response.json()) as {
        success: boolean;
        role: string;
      };

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.role).toBe("admin");
    });

    it("admin connects to an unbound workspace (binds it)", async () => {
      const { workspaceId } = await givenUnboundWorkspace({ isAdmin: true });
      const slackUserId = `U-${uniqueId("slack")}`;

      const request = createTestRequest(
        "http://localhost:3000/api/zero/integrations/slack/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, slackUserId }),
        },
      );
      const response = await POST(request);
      const data = (await response.json()) as {
        success: boolean;
        role: string;
      };

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.role).toBe("admin");
    });

    it("returns 403 when non-admin tries to connect unbound workspace", async () => {
      const { workspaceId } = await givenUnboundWorkspace({ isAdmin: false });

      const request = createTestRequest(
        "http://localhost:3000/api/zero/integrations/slack/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            slackUserId: "U-member",
          }),
        },
      );
      const response = await POST(request);
      const data = (await response.json()) as {
        error: { code: string; message: string };
      };

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
      expect(data.error.message).toContain("Only org admins");
    });

    it("returns 403 when workspace is bound to a different org", async () => {
      // Set up org A (admin) with a bound workspace
      await context.setupUser();
      const orgA = await createTestOrg(uniqueId("org-a"));
      const { slackWorkspaceId } = await createTestSlackOrgInstallation({
        orgId: orgA.id,
      });

      // Set up a completely separate user B in a different org
      const userB = await context.setupUser({ prefix: "user-b" });

      mockClerk({
        userId: userB.userId,
        orgId: userB.orgId,
      });

      const request = createTestRequest(
        "http://localhost:3000/api/zero/integrations/slack/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: slackWorkspaceId,
            slackUserId: "U-orgb-user",
          }),
        },
      );
      const response = await POST(request);
      const data = (await response.json()) as {
        error: { code: string; message: string };
      };

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");

      // Verify no connection was created
      const connection = await findTestSlackOrgConnection(
        "U-orgb-user",
        slackWorkspaceId,
      );
      expect(connection).toBeUndefined();
    });

    it("returns 403 with switch-org message when user is member of target org but wrong active org", async () => {
      // User is a member of two orgs; workspace is bound to orgA
      const { userId } = await context.setupUser();
      const orgASlug = uniqueId("org-a");
      const orgA = await createTestOrg(orgASlug);
      const { slackWorkspaceId } = await createTestSlackOrgInstallation({
        orgId: orgA.id,
      });

      // Create a second org and set it as active (wrong active org)
      const orgBId = uniqueId("org-b");
      const orgBSlug = uniqueId("org-b");
      await insertOrgCacheEntry({ orgId: orgBId, slug: orgBSlug });

      mockClerk({
        userId,
        orgId: orgBId,
        clerkOrgs: [
          { id: orgA.id, slug: orgASlug, name: orgASlug },
          { id: orgBId, slug: orgBSlug, name: orgBSlug },
        ],
      });

      const request = createTestRequest(
        "http://localhost:3000/api/zero/integrations/slack/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: slackWorkspaceId,
            slackUserId: "U-wrong-active",
          }),
        },
      );
      const response = await POST(request);
      const data = (await response.json()) as {
        error: { message: string };
      };

      expect(response.status).toBe(403);
      expect(data.error.message).toContain(
        "switch to the correct organization",
      );
    });

    it("connect is idempotent — second connect returns success", async () => {
      const { workspaceId } = await givenBoundWorkspace();
      const slackUserId = `U-${uniqueId("slack")}`;

      // First connect
      const body = JSON.stringify({ workspaceId, slackUserId });
      const req1 = createTestRequest(
        "http://localhost:3000/api/zero/integrations/slack/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
      );
      const res1 = await POST(req1);
      expect(res1.status).toBe(200);

      // Second connect — same user, same workspace
      const req2 = createTestRequest(
        "http://localhost:3000/api/zero/integrations/slack/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
      );
      const res2 = await POST(req2);
      expect(res2.status).toBe(200);
    });
  });
});
