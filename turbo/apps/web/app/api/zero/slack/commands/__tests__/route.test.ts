import { createHmac } from "crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  enableModelFirstModelProviderForUser,
  insertOrgModelPolicy,
  insertUserModelPreference,
  updateOrgDefaultAgent,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  createTestSlackOrgInstallation,
  seedTestSlackOrgConnection,
} from "../../../../../../src/__tests__/db-test-seeders/slack";
import { countSlackOrgConnections } from "../../../../../../src/__tests__/db-test-assertions/slack";
import { reloadEnv } from "../../../../../../src/env";

const { POST } = await import("../route");

const SIGNING_SECRET = "test-slack-signing-secret";

const context = testContext();

/** Build a URL-encoded slash command body */
function buildCommandBody(
  overrides: Partial<{
    team_id: string;
    user_id: string;
    channel_id: string;
    command: string;
    text: string;
  }>,
): string {
  const params = new URLSearchParams({
    token: "test-token",
    team_id: overrides.team_id ?? "T-test",
    team_domain: "test-workspace",
    channel_id: overrides.channel_id ?? "C-test",
    channel_name: "general",
    user_id: overrides.user_id ?? "U-test",
    user_name: "testuser",
    command: overrides.command ?? "/vm0",
    text: overrides.text ?? "",
    response_url: "https://hooks.slack.com/commands/T-test/response",
    trigger_id: "trigger-123",
    api_app_id: "A-test",
  });
  return params.toString();
}

/** Create a signed Slack command request */
function createCommandRequest(body: string): Request {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const baseString = `v0:${timestamp}:${body}`;
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(baseString).digest("hex")}`;

  return new Request("http://localhost:3000/api/zero/slack/commands", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

describe("POST /api/zero/slack/commands", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    reloadEnv();
  });

  describe("signature verification", () => {
    it("returns 401 when signature headers are missing", async () => {
      const request = new Request(
        "http://localhost:3000/api/zero/slack/commands",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: buildCommandBody({ text: "help" }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("returns 401 when signature is invalid", async () => {
      const body = buildCommandBody({ text: "help" });
      const request = new Request(
        "http://localhost:3000/api/zero/slack/commands",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "x-slack-request-timestamp": Math.floor(
              Date.now() / 1000,
            ).toString(),
            "x-slack-signature": "v0=invalid_signature",
          },
          body,
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(401);
    });
  });

  describe("/vm0 help", () => {
    it("returns help message for empty text", async () => {
      const body = buildCommandBody({ text: "" });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.response_type).toBe("ephemeral");
      expect(data.blocks).toBeDefined();
    });

    it("returns help message for 'help' subcommand", async () => {
      const body = buildCommandBody({ text: "help" });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.response_type).toBe("ephemeral");
    });

    it("returns help message for unknown subcommand", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const body = buildCommandBody({
        team_id: workspaceId,
        user_id: slackUserId,
        text: "foobar",
      });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.response_type).toBe("ephemeral");
    });
  });

  describe("/vm0 connect", () => {
    it("returns not-installed message when no installation exists", async () => {
      const body = buildCommandBody({
        team_id: "T-nonexistent",
        text: "connect",
      });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.response_type).toBe("ephemeral");
      expect(JSON.stringify(data.blocks)).toContain("hasn't been set up");
    });

    it("returns login URL when user is not connected", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const body = buildCommandBody({
        team_id: workspaceId,
        user_id: "U-not-connected",
        text: "connect",
      });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.response_type).toBe("ephemeral");
      // Login message contains a connect URL
      expect(JSON.stringify(data.blocks)).toContain("connect");
    });

    it("returns already-connected message when user is connected", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const body = buildCommandBody({
        team_id: workspaceId,
        user_id: slackUserId,
        text: "connect",
      });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.response_type).toBe("ephemeral");
      expect(JSON.stringify(data.blocks)).toContain("already connected");
    });

    it("does not include agent name in already-connected message", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });
      const compose = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, compose.agentId);

      const body = buildCommandBody({
        team_id: workspaceId,
        user_id: slackUserId,
        text: "connect",
      });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(JSON.stringify(data.blocks)).toContain("already connected");
      expect(JSON.stringify(data.blocks)).not.toContain("workspace agent");
    });
  });

  describe("/vm0 disconnect", () => {
    it("returns not-installed message when no installation exists", async () => {
      const body = buildCommandBody({
        team_id: "T-nonexistent",
        text: "disconnect",
      });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(JSON.stringify(data.blocks)).toContain("hasn't been set up");
    });

    it("returns error when user is not connected", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const body = buildCommandBody({
        team_id: workspaceId,
        user_id: "U-not-connected",
        text: "disconnect",
      });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(JSON.stringify(data.blocks)).toContain("not connected");
    });

    it("disconnects user and returns success message", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const body = buildCommandBody({
        team_id: workspaceId,
        user_id: slackUserId,
        text: "disconnect",
      });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(JSON.stringify(data.blocks)).toContain("disconnected");

      // Verify connection was actually deleted
      expect(await countSlackOrgConnections(workspaceId)).toBe(0);
    });
  });

  describe("/vm0 switch", () => {
    it("opens the agent picker modal for a connected user", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });
      const defaultCompose = await createTestCompose(uniqueId("default"));
      await updateOrgDefaultAgent(user.orgId, defaultCompose.agentId);
      const alternate = await createTestCompose(uniqueId("alt"));

      const body = buildCommandBody({
        team_id: workspaceId,
        user_id: slackUserId,
        text: "switch",
      });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.views.open).toHaveBeenCalledOnce();
      const callArgs = (mockClient.views.open as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as {
        trigger_id?: string;
        view?: {
          callback_id?: string;
          blocks?: Array<{
            element?: { options?: Array<{ value: string }> };
          }>;
        };
      };
      expect(callArgs?.trigger_id).toBe("trigger-123");
      expect(callArgs?.view?.callback_id).toBe("switch_agent_modal");

      const inputBlock = callArgs?.view?.blocks?.find((b) => {
        return b.element?.options !== undefined;
      });
      const values =
        inputBlock?.element?.options?.map((o) => {
          return o.value;
        }) ?? [];
      expect(values).toContain("__org_default__");
      expect(values).toContain(alternate.composeId);
      // Default compose must be filtered out of the picker.
      expect(values).not.toContain(defaultCompose.composeId);
    });

    it("returns login prompt when user is not connected", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const body = buildCommandBody({
        team_id: workspaceId,
        user_id: "U-not-connected",
        text: "switch",
      });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.response_type).toBe("ephemeral");

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.views.open).not.toHaveBeenCalled();
    });

    it("help output advertises the switch subcommand for org-bound workspaces", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const body = buildCommandBody({ team_id: workspaceId, text: "help" });
      const request = createCommandRequest(body);
      const response = await POST(request);

      const data = await response.json();
      expect(JSON.stringify(data.blocks)).toContain("/zero switch");
    });

    it("help output omits switch when the workspace is not bound to an org", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      const body = buildCommandBody({ team_id: workspaceId, text: "help" });
      const request = createCommandRequest(body);
      const response = await POST(request);

      const data = await response.json();
      expect(JSON.stringify(data.blocks)).not.toContain("/zero switch");
      expect(JSON.stringify(data.blocks)).toContain("/zero connect");
    });
  });

  describe("/vm0 model", () => {
    it("opens the model picker modal for a connected model-first user", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });
      await enableModelFirstModelProviderForUser(user.orgId, user.userId);
      await insertOrgModelPolicy({
        orgId: user.orgId,
        model: "claude-sonnet-4-6",
        isDefault: true,
      });
      await insertOrgModelPolicy({
        orgId: user.orgId,
        model: "deepseek-v4-pro",
      });
      await insertOrgModelPolicy({
        orgId: user.orgId,
        model: "gpt-5.5",
      });
      await insertUserModelPreference({
        orgId: user.orgId,
        userId: user.userId,
        model: "deepseek-v4-pro",
      });

      const body = buildCommandBody({
        team_id: workspaceId,
        user_id: slackUserId,
        text: "model",
      });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.views.open).toHaveBeenCalledOnce();
      const callArgs = (mockClient.views.open as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as {
        trigger_id?: string;
        view?: {
          callback_id?: string;
          blocks?: Array<{
            element?: {
              options?: Array<{
                value: string;
                text?: { text?: string };
              }>;
              initial_option?: { value: string };
            };
          }>;
        };
      };
      expect(callArgs?.trigger_id).toBe("trigger-123");
      expect(callArgs?.view?.callback_id).toBe("model_preference_modal");

      const inputBlock = callArgs?.view?.blocks?.find((b) => {
        return b.element?.options !== undefined;
      });
      const values =
        inputBlock?.element?.options?.map((o) => {
          return o.value;
        }) ?? [];
      const labels =
        inputBlock?.element?.options?.map((o) => {
          return o.text?.text;
        }) ?? [];
      expect(values).not.toContain("__workspace_default__");
      expect(values).toContain("claude-sonnet-4-6");
      expect(values).toContain("deepseek-v4-pro");
      expect(values).not.toContain("gpt-5.5");
      expect(labels).toContain("Claude Sonnet 4.6 (workspace default)");
      expect(inputBlock?.element?.initial_option?.value).toBe(
        "deepseek-v4-pro",
      );
    });

    it("returns an error when model-first is not enabled", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const body = buildCommandBody({
        team_id: workspaceId,
        user_id: slackUserId,
        text: "model",
      });
      const request = createCommandRequest(body);
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.response_type).toBe("ephemeral");
      expect(JSON.stringify(data.blocks)).toContain("not available");

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.views.open).not.toHaveBeenCalled();
    });

    it("help output advertises model only for connected model-first users", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });
      await enableModelFirstModelProviderForUser(user.orgId, user.userId);

      const body = buildCommandBody({
        team_id: workspaceId,
        user_id: slackUserId,
        text: "help",
      });
      const request = createCommandRequest(body);
      const response = await POST(request);

      const data = await response.json();
      expect(JSON.stringify(data.blocks)).toContain("/zero model");
    });
  });
});
