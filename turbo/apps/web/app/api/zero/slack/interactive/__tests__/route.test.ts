import { createHmac } from "crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  updateOrgDefaultAgent,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  createTestSlackOrgInstallation,
  seedTestSlackOrgConnection,
} from "../../../../../../src/__tests__/db-test-seeders/slack";
import {
  countSlackOrgConnections,
  findSlackUserAgentPreference,
  seedSlackUserAgentPreference,
} from "../../../../../../src/__tests__/db-test-assertions/slack";
import { reloadEnv } from "../../../../../../src/env";

vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core/feature-switch");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const { POST } = await import("../route");

function buildAgentPickerSubmission(opts: {
  workspaceId: string;
  slackUserId: string;
  selectedValue: string;
  channelId?: string;
}): Record<string, unknown> {
  return {
    type: "view_submission",
    user: {
      id: opts.slackUserId,
      username: "testuser",
      team_id: opts.workspaceId,
    },
    team: { id: opts.workspaceId, domain: "test" },
    view: {
      id: "V-picker",
      callback_id: "switch_agent_modal",
      ...(opts.channelId && {
        private_metadata: JSON.stringify({ channelId: opts.channelId }),
      }),
      state: {
        values: {
          agent_select_block: {
            agent_select: {
              selected_option: { value: opts.selectedValue },
            },
          },
        },
      },
    },
  };
}

const SIGNING_SECRET = "test-slack-signing-secret";

const context = testContext();

/** Build a signed interactive request with JSON payload */
function createInteractiveRequest(payload: Record<string, unknown>): Request {
  const payloadStr = JSON.stringify(payload);
  const body = new URLSearchParams({ payload: payloadStr }).toString();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const baseString = `v0:${timestamp}:${body}`;
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(baseString).digest("hex")}`;

  return new Request("http://localhost:3000/api/zero/slack/interactive", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

describe("POST /api/zero/slack/interactive", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    reloadEnv();
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  describe("signature verification", () => {
    it("returns 401 when signature headers are missing", async () => {
      const body = new URLSearchParams({
        payload: JSON.stringify({ type: "block_actions" }),
      }).toString();
      const request = new Request(
        "http://localhost:3000/api/zero/slack/interactive",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(401);
    });
  });

  describe("payload validation", () => {
    it("returns 400 when payload param is missing", async () => {
      const body = "foo=bar";
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const baseString = `v0:${timestamp}:${body}`;
      const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(baseString).digest("hex")}`;

      const request = new Request(
        "http://localhost:3000/api/zero/slack/interactive",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": signature,
          },
          body,
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });

  describe("home_disconnect", () => {
    it("disconnects user and refreshes App Home", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const request = createInteractiveRequest({
        type: "block_actions",
        user: { id: slackUserId, username: "testuser", team_id: workspaceId },
        team: { id: workspaceId, domain: "test" },
        actions: [{ action_id: "home_disconnect", block_id: "home" }],
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Connection should be deleted
      expect(await countSlackOrgConnections(workspaceId)).toBe(0);

      // App Home should be refreshed
      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.views.publish).toHaveBeenCalledOnce();
    });

    it("silently returns when user has no connection", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createInteractiveRequest({
        type: "block_actions",
        user: {
          id: "U-no-connection",
          username: "testuser",
          team_id: workspaceId,
        },
        team: { id: workspaceId, domain: "test" },
        actions: [{ action_id: "home_disconnect", block_id: "home" }],
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
    });
  });

  it("returns 200 with no action for empty actions array", async () => {
    const request = createInteractiveRequest({
      type: "block_actions",
      user: { id: "U-test", username: "testuser", team_id: "T-test" },
      team: { id: "T-test", domain: "test" },
      actions: [],
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
  });

  describe("switch_agent_modal view_submission", () => {
    it("persists the selected agent and posts an ephemeral confirmation", async () => {
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

      const request = createInteractiveRequest(
        buildAgentPickerSubmission({
          workspaceId,
          slackUserId,
          selectedValue: alternate.composeId,
          channelId: "C-origin",
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      const saved = await findSlackUserAgentPreference(user.userId, user.orgId);
      expect(saved?.selectedComposeId).toBe(alternate.composeId);

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledOnce();
      const ephemeralArgs = (
        mockClient.chat.postEphemeral as unknown as {
          mock: { calls: Array<[Record<string, unknown>]> };
        }
      ).mock.calls[0]?.[0];
      expect(ephemeralArgs?.channel).toBe("C-origin");
    });

    it("clears the override when user picks the org default option", async () => {
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

      await seedSlackUserAgentPreference({
        vm0UserId: user.userId,
        orgId: user.orgId,
        composeId: alternate.composeId,
      });

      const request = createInteractiveRequest(
        buildAgentPickerSubmission({
          workspaceId,
          slackUserId,
          selectedValue: "__org_default__",
          channelId: "C-origin",
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      const saved = await findSlackUserAgentPreference(user.userId, user.orgId);
      expect(saved?.selectedComposeId).toBeNull();
    });

    it("rejects agents that belong to a different org with inline error", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const request = createInteractiveRequest(
        buildAgentPickerSubmission({
          workspaceId,
          slackUserId,
          selectedValue: "00000000-0000-0000-0000-000000000000",
          channelId: "C-origin",
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        response_action?: string;
        errors?: Record<string, string>;
      };
      expect(body.response_action).toBe("errors");
      expect(body.errors?.agent_select_block).toBeTruthy();

      const saved = await findSlackUserAgentPreference(user.userId, user.orgId);
      expect(saved).toBeUndefined();
    });
  });

  describe("home_switch_agent block_action", () => {
    it("opens the agent picker modal from App Home", async () => {
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
      await createTestCompose(uniqueId("alt"));

      const request = createInteractiveRequest({
        type: "block_actions",
        user: { id: slackUserId, username: "testuser", team_id: workspaceId },
        team: { id: workspaceId, domain: "test" },
        trigger_id: "trigger-home",
        actions: [{ action_id: "home_switch_agent", block_id: "home" }],
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.views.open).toHaveBeenCalledOnce();
    });

    it("does not open picker when feature is gated off for the org", async () => {
      mockIsFeatureEnabled.mockReturnValue(false);

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
      await createTestCompose(uniqueId("alt"));

      const request = createInteractiveRequest({
        type: "block_actions",
        user: { id: slackUserId, username: "testuser", team_id: workspaceId },
        team: { id: workspaceId, domain: "test" },
        trigger_id: "trigger-home",
        actions: [{ action_id: "home_switch_agent", block_id: "home" }],
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.views.open).not.toHaveBeenCalled();
    });
  });

  describe("switch_agent_modal feature gate defense", () => {
    it("does not persist a preference when the feature is gated off", async () => {
      mockIsFeatureEnabled.mockReturnValue(false);

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

      const request = createInteractiveRequest(
        buildAgentPickerSubmission({
          workspaceId,
          slackUserId,
          selectedValue: alternate.composeId,
          channelId: "C-origin",
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      const saved = await findSlackUserAgentPreference(user.userId, user.orgId);
      expect(saved).toBeUndefined();
    });
  });
});
