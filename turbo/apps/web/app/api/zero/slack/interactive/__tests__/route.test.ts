import { createHmac } from "crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestSlackOrgInstallation,
  seedTestSlackOrgConnection,
  seedTestSlackOrgPendingQuestion,
  updateOrgDefaultAgent,
  countSlackOrgConnections,
} from "../../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../../src/env";

import { POST } from "../route";

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

  describe("ask_user_submit", () => {
    it("claims pending question and dispatches run", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      const channelId = uniqueId("C-ch");
      const threadTs = uniqueId("ts");

      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      const { connectionId } = await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });
      const compose = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, compose.agentId);

      const messageTs = uniqueId("msg-ts");
      const { pendingQuestionId } = await seedTestSlackOrgPendingQuestion({
        runId: uniqueId("run"),
        slackWorkspaceId: workspaceId,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        slackMessageTs: messageTs,
        connectionId,
        composeId: compose.composeId,
        agentName: "test-agent",
        questions: [
          {
            question: "Pick a color",
            options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
            multiSelect: true,
          },
        ],
        expiresAt: new Date(Date.now() + 3600000),
      });

      const request = createInteractiveRequest({
        type: "block_actions",
        user: { id: slackUserId, username: "testuser", team_id: workspaceId },
        team: { id: workspaceId, domain: "test" },
        channel: { id: channelId },
        message: { ts: messageTs },
        actions: [
          {
            action_id: "ask_user_submit",
            block_id: "submit",
            value: pendingQuestionId,
          },
        ],
        state: {
          values: {
            ask_user_block_q0: {
              ask_user_select_q0: {
                type: "static_select",
                selected_options: [{ value: "q0_o0" }],
              },
            },
          },
        },
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Wait for the fire-and-forget async handler to complete
      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      await vi.waitFor(() => {
        expect(mockClient.chat.update).toHaveBeenCalled();
      });
    });

    it("silently returns for expired pending question", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      const channelId = uniqueId("C-ch");
      const threadTs = uniqueId("ts");

      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      const { connectionId } = await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });
      const compose = await createTestCompose(uniqueId("agent"));

      const { pendingQuestionId } = await seedTestSlackOrgPendingQuestion({
        runId: uniqueId("run"),
        slackWorkspaceId: workspaceId,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        connectionId,
        composeId: compose.composeId,
        agentName: "test-agent",
        questions: [{ question: "Pick one", options: [{ label: "A" }] }],
        expiresAt: new Date(Date.now() - 1000), // already expired
      });

      const request = createInteractiveRequest({
        type: "block_actions",
        user: { id: slackUserId, username: "testuser", team_id: workspaceId },
        team: { id: workspaceId, domain: "test" },
        actions: [
          {
            action_id: "ask_user_submit",
            block_id: "submit",
            value: pendingQuestionId,
          },
        ],
        state: { values: {} },
      });

      // Get mock client reference before POST so we can verify after
      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Wait for the fire-and-forget handler to settle, then verify no card update
      await vi.waitFor(() => {
        expect(mockClient.chat.update).not.toHaveBeenCalled();
      });
    });

    it("rejects unauthorized submitter", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      const wrongUserId = uniqueId("U-wrong");
      const channelId = uniqueId("C-ch");
      const threadTs = uniqueId("ts");

      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      const { connectionId } = await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });
      const compose = await createTestCompose(uniqueId("agent"));

      const { pendingQuestionId } = await seedTestSlackOrgPendingQuestion({
        runId: uniqueId("run"),
        slackWorkspaceId: workspaceId,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        connectionId,
        composeId: compose.composeId,
        agentName: "test-agent",
        questions: [{ question: "Pick one", options: [{ label: "A" }] }],
        expiresAt: new Date(Date.now() + 3600000),
      });

      // Wrong user tries to submit
      const request = createInteractiveRequest({
        type: "block_actions",
        user: { id: wrongUserId, username: "wrong", team_id: workspaceId },
        team: { id: workspaceId, domain: "test" },
        actions: [
          {
            action_id: "ask_user_submit",
            block_id: "submit",
            value: pendingQuestionId,
          },
        ],
        state: { values: {} },
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Wait for the fire-and-forget async handler to complete
      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      await vi.waitFor(() => {
        expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
          expect.objectContaining({
            user: wrongUserId,
            text: expect.stringContaining("Only the person who started"),
          }),
        );
      });
    });
  });

  describe("direct_pick", () => {
    it("claims pending question and dispatches run for single-select", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      const channelId = uniqueId("C-ch");
      const threadTs = uniqueId("ts");

      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      const { connectionId } = await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });
      const compose = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, compose.agentId);

      const messageTs = uniqueId("msg-ts");
      const { pendingQuestionId } = await seedTestSlackOrgPendingQuestion({
        runId: uniqueId("run"),
        slackWorkspaceId: workspaceId,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        slackMessageTs: messageTs,
        connectionId,
        composeId: compose.composeId,
        agentName: "test-agent",
        questions: [
          {
            question: "Pick a fruit",
            options: [{ label: "Apple" }, { label: "Banana" }],
          },
        ],
        expiresAt: new Date(Date.now() + 3600000),
      });

      const request = createInteractiveRequest({
        type: "block_actions",
        user: { id: slackUserId, username: "testuser", team_id: workspaceId },
        team: { id: workspaceId, domain: "test" },
        channel: { id: channelId },
        message: { ts: messageTs },
        actions: [
          {
            action_id: "ask_user_pick_q0_o1",
            block_id: "pick",
            value: pendingQuestionId,
          },
        ],
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Wait for the fire-and-forget async handler to complete
      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      await vi.waitFor(() => {
        expect(mockClient.chat.update).toHaveBeenCalled();
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
  });
});
