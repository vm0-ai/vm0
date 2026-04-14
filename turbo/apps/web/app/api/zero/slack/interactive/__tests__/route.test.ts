import { createHmac } from "crypto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestSlackOrgInstallation,
  seedTestSlackOrgConnection,
} from "../../../../../../src/__tests__/db-test-seeders/slack";
import { countSlackOrgConnections } from "../../../../../../src/__tests__/db-test-assertions/slack";
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
