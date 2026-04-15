import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import {
  createTestSlackOrgInstallation,
  seedTestSlackOrgConnection,
} from "../../../../../../src/__tests__/db-test-seeders/slack";
import { countSlackOrgConnections } from "../../../../../../src/__tests__/db-test-assertions/slack";

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/slack/connect";

function connectUrl(params: {
  workspaceId: string;
  slackUserId: string;
  channelId?: string;
  threadTs?: string;
  orgId?: string;
}): string {
  const url = new URL(BASE_URL);
  url.searchParams.set("w", params.workspaceId);
  url.searchParams.set("u", params.slackUserId);
  if (params.channelId) {
    url.searchParams.set("c", params.channelId);
  }
  if (params.threadTs) {
    url.searchParams.set("t", params.threadTs);
  }
  if (params.orgId) {
    url.searchParams.set("orgId", params.orgId);
  }
  return url.toString();
}

describe("GET /api/zero/slack/connect", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  // ---------------------------------------------------------------------------
  // Admin connect — unbound workspace
  // ---------------------------------------------------------------------------

  describe("admin connect — unbound workspace", () => {
    it("binds workspace to org and creates connection", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      const request = new Request(connectUrl({ workspaceId, slackUserId }));
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("status=connected");
      expect(await countSlackOrgConnections(workspaceId)).toBe(1);
    });

    it("is idempotent when workspace is already bound to same org", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: user.orgId,
      });

      const request = new Request(
        connectUrl({ workspaceId, slackUserId, orgId: user.orgId }),
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("status=connected");
    });

    it("redirects error when workspace bound to different org", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: uniqueId("org-other"),
      });

      const request = new Request(
        connectUrl({
          workspaceId,
          slackUserId: uniqueId("U-slack"),
          orgId: user.orgId,
        }),
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("error=");
      expect(response.headers.get("Location")).toContain("organization");
    });

    it("handles idempotent reconnect with existing connection", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      const url = connectUrl({ workspaceId, slackUserId });

      // First connect
      const response1 = await GET(new Request(url));
      expect(response1.status).toBe(307);
      expect(response1.headers.get("Location")).toContain("status=connected");

      // Second connect — should not throw, still 1 connection
      const response2 = await GET(new Request(url));
      expect(response2.status).toBe(307);
      expect(response2.headers.get("Location")).toContain("status=connected");
      expect(await countSlackOrgConnections(workspaceId)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Member connect — bound workspace
  // ---------------------------------------------------------------------------

  describe("member connect — bound workspace", () => {
    it("creates connection for bound workspace", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: user.orgId,
      });

      // Switch to member role
      mockClerk({ userId: user.userId, orgRole: "org:member" });

      const request = new Request(
        connectUrl({ workspaceId, slackUserId, orgId: user.orgId }),
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("status=connected");
      expect(await countSlackOrgConnections(workspaceId)).toBe(1);
    });

    it("redirects error when workspace not installed", async () => {
      mockClerk({ userId: user.userId, orgRole: "org:member" });

      const request = new Request(
        connectUrl({
          workspaceId: "T-nonexistent",
          slackUserId: uniqueId("U-slack"),
          orgId: user.orgId,
        }),
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("error=");
      expect(response.headers.get("Location")).toContain("Workspace");
    });

    it("redirects error when unbound workspace and non-admin", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      // Switch to member role
      mockClerk({ userId: user.userId, orgRole: "org:member" });

      const request = new Request(
        connectUrl({
          workspaceId,
          slackUserId: uniqueId("U-slack"),
        }),
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("error=");
      expect(response.headers.get("Location")).toContain("admin");
    });

    it("redirects error when workspace bound to different org", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: uniqueId("org-other"),
      });

      mockClerk({ userId: user.userId, orgRole: "org:member" });

      const request = new Request(
        connectUrl({
          workspaceId,
          slackUserId: uniqueId("U-slack"),
          orgId: user.orgId,
        }),
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("error=");
      expect(response.headers.get("Location")).toContain("organization");
    });
  });

  // ---------------------------------------------------------------------------
  // Notifications (fire-and-forget)
  // ---------------------------------------------------------------------------

  describe("notifications (fire-and-forget)", () => {
    it("sends ephemeral message when channelId provided", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      const channelId = uniqueId("C-ch");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      const request = new Request(
        connectUrl({ workspaceId, slackUserId, channelId }),
      );
      const response = await GET(request);
      expect(response.status).toBe(307);

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      await vi.waitFor(() => {
        expect(mockClient.chat.postEphemeral).toHaveBeenCalledOnce();
        expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: channelId,
            user: slackUserId,
          }),
        );
      });
    });

    it("falls back to DM when postEphemeral fails", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      const channelId = uniqueId("C-ch");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      // Make postEphemeral fail
      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      const ephemeralFn = mockClient.chat.postEphemeral as ReturnType<
        typeof vi.fn
      >;
      ephemeralFn.mockRejectedValueOnce(new Error("channel_not_found"));

      const request = new Request(
        connectUrl({ workspaceId, slackUserId, channelId }),
      );
      const response = await GET(request);
      expect(response.status).toBe(307);

      await vi.waitFor(() => {
        // Should have attempted ephemeral first
        expect(ephemeralFn).toHaveBeenCalledOnce();

        // Then fallen back to DM via postMessage
        const postMessageFn = mockClient.chat.postMessage as ReturnType<
          typeof vi.fn
        >;
        expect(postMessageFn.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
    });

    it("sends DM with welcome thread when no channelId", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      const request = new Request(connectUrl({ workspaceId, slackUserId }));
      const response = await GET(request);
      expect(response.status).toBe(307);

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      await vi.waitFor(() => {
        // Should send connect success DM and welcome thread reply
        expect(
          (mockClient.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
            .length,
        ).toBeGreaterThanOrEqual(2);
      });
    });

    it("does not send prompt DM (connect flow has no pendingPrompt)", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: user.orgId,
      });

      // Seed a connection so notification doesn't fail on missing connection
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const request = new Request(
        connectUrl({ workspaceId, slackUserId, orgId: user.orgId }),
      );
      const response = await GET(request);
      expect(response.status).toBe(307);

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      await vi.waitFor(() => {
        const postMessageFn = mockClient.chat.postMessage as ReturnType<
          typeof vi.fn
        >;
        expect(postMessageFn.mock.calls.length).toBeGreaterThanOrEqual(1);
      });

      // Verify no prompt DM was sent
      const postMessageFn = mockClient.chat.postMessage as ReturnType<
        typeof vi.fn
      >;
      const promptCall = postMessageFn.mock.calls.find((call: unknown[]) => {
        return (
          typeof call[0] === "object" &&
          call[0] !== null &&
          "text" in call[0] &&
          typeof (call[0] as { text: string }).text === "string" &&
          (call[0] as { text: string }).text.includes(
            "would you like me to run",
          )
        );
      });
      expect(promptCall).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Route-level validation
  // ---------------------------------------------------------------------------

  describe("route-level validation", () => {
    it("redirects to sign-in when unauthenticated", async () => {
      mockClerk({ userId: null });

      const workspaceId = uniqueId("T-ws");
      const request = new Request(
        connectUrl({
          workspaceId,
          slackUserId: uniqueId("U-slack"),
        }),
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("sign-in");
    });

    it("redirects error when missing required query params", async () => {
      // Missing both w and u params
      const request = new Request(BASE_URL);
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("error=");
      expect(response.headers.get("Location")).toContain("Invalid");
    });

    it("redirects error when user org does not match workspace org", async () => {
      const workspaceId = uniqueId("T-ws");
      const otherOrgId = uniqueId("org-other");
      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: otherOrgId,
      });

      const request = new Request(
        connectUrl({
          workspaceId,
          slackUserId: uniqueId("U-slack"),
        }),
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("error=");
      expect(response.headers.get("Location")).toContain("organization");
    });
  });
});
