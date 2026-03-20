import { createHmac } from "crypto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestSlackOrgInstallation,
  seedTestSlackOrgConnection,
  seedTestCompose,
  seedTestSlackOrgPendingQuestion,
  updateOrgDefaultAgent,
  countSlackOrgInstallations,
  countSlackOrgConnections,
  countSlackOrgPendingQuestions,
} from "../../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../../src/env";

import { POST } from "../route";

const SIGNING_SECRET = "test-slack-signing-secret";

const context = testContext();

/** Create a Slack event request with valid HMAC signature */
function createSlackEventRequest(payload: Record<string, unknown>): Request {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const baseString = `v0:${timestamp}:${body}`;
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(baseString).digest("hex")}`;

  return new Request("http://localhost:3000/api/zero/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

describe("POST /api/zero/slack/events", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    reloadEnv();
  });

  describe("url_verification", () => {
    it("returns challenge for url_verification event", async () => {
      const request = createSlackEventRequest({
        type: "url_verification",
        challenge: "test-challenge-123",
        token: "test-token",
      });
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.challenge).toBe("test-challenge-123");
    });
  });

  describe("signature verification", () => {
    it("returns 401 when signature headers are missing", async () => {
      const request = new Request(
        "http://localhost:3000/api/zero/slack/events",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "event_callback" }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("returns 401 when signature is invalid", async () => {
      const request = new Request(
        "http://localhost:3000/api/zero/slack/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-slack-request-timestamp": Math.floor(
              Date.now() / 1000,
            ).toString(),
            "x-slack-signature": "v0=invalid_signature",
          },
          body: JSON.stringify({ type: "event_callback" }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(401);
    });
  });

  describe("app_mention — error deduplication", () => {
    async function setupWorkspace(orgId: string) {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");

      await createTestSlackOrgInstallation({ workspaceId, orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      return { workspaceId, slackUserId };
    }

    it("does not post error when run was created (callback handles it)", async () => {
      const compose = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, compose.composeId);
      const { workspaceId, slackUserId } = await setupWorkspace(user.orgId);

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: slackUserId,
          text: "Hello agent",
          ts: "1000.001",
          channel: "C-test",
          event_ts: "1000.001",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Drain after() callbacks to run the handler
      await context.mocks.flushAfter();

      // The run was created but dispatch failed → callback handles error.
      // Verify via Slack mock: postMessage should NOT have been called for error
      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it("posts error when run was not created (no callback)", async () => {
      // Set up a compose WITHOUT a version → startRun fails before creating the run
      const { composeId } = await seedTestCompose({
        userId: user.userId,
        name: uniqueId("agent"),
        orgId: user.orgId,
      });
      await updateOrgDefaultAgent(user.orgId, composeId);
      const { workspaceId, slackUserId } = await setupWorkspace(user.orgId);

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: slackUserId,
          text: "Hello agent",
          ts: "1000.002",
          channel: "C-test",
          event_ts: "1000.002",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      // startRun failed before creating a run → no callback → handler posts error
      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
    });
  });

  describe("direct_message — error deduplication", () => {
    async function setupWorkspace(orgId: string) {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");

      await createTestSlackOrgInstallation({ workspaceId, orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      return { workspaceId, slackUserId };
    }

    it("does not post error when run was created (callback handles it)", async () => {
      const compose = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, compose.composeId);
      const { workspaceId, slackUserId } = await setupWorkspace(user.orgId);

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: slackUserId,
          text: "Hello agent",
          ts: "2000.001",
          channel: "D-test",
          event_ts: "2000.001",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it("posts error when run was not created (no callback)", async () => {
      const { composeId } = await seedTestCompose({
        userId: user.userId,
        name: uniqueId("agent"),
        orgId: user.orgId,
      });
      await updateOrgDefaultAgent(user.orgId, composeId);
      const { workspaceId, slackUserId } = await setupWorkspace(user.orgId);

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: slackUserId,
          text: "Hello agent",
          ts: "2000.002",
          channel: "D-test",
          event_ts: "2000.002",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
    });
  });

  describe("app_uninstalled — cleanup", () => {
    it("deletes installation and all connections for a workspace", async () => {
      const workspaceId = uniqueId("T-ws");

      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: uniqueId("org"),
      });
      await seedTestSlackOrgConnection({
        slackUserId: "U001",
        slackWorkspaceId: workspaceId,
        vm0UserId: uniqueId("user"),
      });
      await seedTestSlackOrgConnection({
        slackUserId: "U002",
        slackWorkspaceId: workspaceId,
        vm0UserId: uniqueId("user"),
      });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: { type: "app_uninstalled" },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      expect(await countSlackOrgInstallations(workspaceId)).toBe(0);
      expect(await countSlackOrgConnections(workspaceId)).toBe(0);
    });

    it("deletes pending questions before connections", async () => {
      const workspaceId = uniqueId("T-ws");
      const orgId = uniqueId("org");

      await createTestSlackOrgInstallation({ workspaceId, orgId });

      const { connectionId } = await seedTestSlackOrgConnection({
        slackUserId: "U001",
        slackWorkspaceId: workspaceId,
        vm0UserId: uniqueId("user"),
      });

      const { composeId } = await seedTestCompose({
        userId: uniqueId("user"),
        name: uniqueId("compose"),
        orgId,
      });

      await seedTestSlackOrgPendingQuestion({
        runId: uniqueId("run"),
        slackWorkspaceId: workspaceId,
        slackChannelId: "C001",
        slackThreadTs: "1234567890.000001",
        connectionId,
        composeId,
        agentName: "test-agent",
        questions: [{ type: "text", question: "test?" }],
        expiresAt: new Date(Date.now() + 3600000),
      });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: { type: "app_uninstalled" },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      expect(await countSlackOrgPendingQuestions(connectionId)).toBe(0);
      expect(await countSlackOrgConnections(workspaceId)).toBe(0);
      expect(await countSlackOrgInstallations(workspaceId)).toBe(0);
    });

    it("handles nonexistent workspace gracefully", async () => {
      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: "T-nonexistent",
        event: { type: "app_uninstalled" },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Should not throw
      await context.mocks.flushAfter();
    });

    it("handles workspace with no connections", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: { type: "app_uninstalled" },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      expect(await countSlackOrgInstallations(workspaceId)).toBe(0);
    });
  });

  describe("tokens_revoked — cleanup", () => {
    it("cleans up workspace when bot tokens are revoked", async () => {
      const workspaceId = uniqueId("T-ws");

      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: uniqueId("org"),
      });
      await seedTestSlackOrgConnection({
        slackUserId: "U001",
        slackWorkspaceId: workspaceId,
        vm0UserId: uniqueId("user"),
      });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "tokens_revoked",
          tokens: { bot: ["xoxb-revoked"] },
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      expect(await countSlackOrgInstallations(workspaceId)).toBe(0);
      expect(await countSlackOrgConnections(workspaceId)).toBe(0);
    });
  });
});
