import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { POST } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../src/env";
import { server } from "../../../../../src/mocks/server";
import { slackBindings } from "../../../../../src/db/schema/slack-binding";
import { listSecrets } from "../../../../../src/lib/secret/secret-service";

// Mock only external dependencies (third-party packages)
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

// Use the same signing secret as configured in setup.ts
const testSigningSecret = "test-slack-signing-secret";

/**
 * Create a valid Slack signature for testing
 */
function createSlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
): string {
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", signingSecret);
  return `v0=${hmac.update(baseString).digest("hex")}`;
}

/**
 * Create a request with valid Slack signature headers for interactive payload
 */
function createSignedSlackRequest(body: string): Request {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createSlackSignature(testSigningSecret, timestamp, body);

  return new Request("http://localhost/api/slack/interactive", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body,
  });
}

/**
 * Build URL-encoded form body for interactive payload
 */
function buildInteractiveBody(payload: Record<string, unknown>): string {
  const params = new URLSearchParams({
    payload: JSON.stringify(payload),
  });
  return params.toString();
}

describe("POST /api/slack/interactive", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  afterEach(() => {
    server.resetHandlers();
  });

  describe("Configuration", () => {
    it("returns 503 when Slack signing secret is not configured", async () => {
      vi.stubEnv("SLACK_SIGNING_SECRET", "");
      reloadEnv();

      const body = buildInteractiveBody({ type: "block_actions" });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.error).toBe("Slack integration is not configured");

      vi.stubEnv("SLACK_SIGNING_SECRET", testSigningSecret);
      reloadEnv();
    });
  });

  describe("Signature Verification", () => {
    it("returns 401 when signature headers are missing", async () => {
      const body = buildInteractiveBody({ type: "block_actions" });
      const request = new Request("http://localhost/api/slack/interactive", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Missing Slack signature headers");
    });

    it("returns 401 when signature is invalid", async () => {
      const body = buildInteractiveBody({ type: "block_actions" });
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const request = new Request("http://localhost/api/slack/interactive", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-slack-signature": "v0=invalid-signature",
          "x-slack-request-timestamp": timestamp,
        },
        body,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Invalid signature");
    });
  });

  describe("Payload Parsing", () => {
    it("returns 400 when payload is missing", async () => {
      const body = "other=value";
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Missing payload");
    });

    it("returns 400 when payload is invalid JSON", async () => {
      const params = new URLSearchParams({ payload: "not-json" });
      const body = params.toString();
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Invalid payload");
    });
  });

  describe("Block Actions", () => {
    it("returns 200 for block_actions type", async () => {
      const body = buildInteractiveBody({
        type: "block_actions",
        user: { id: "U123", username: "testuser", team_id: "T123" },
        team: { id: "T123", domain: "test" },
        actions: [],
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe("View Submission - Agent Add Modal", () => {
    it("returns error when form values are missing", async () => {
      const body = buildInteractiveBody({
        type: "view_submission",
        user: { id: "U123", username: "testuser", team_id: "T123" },
        team: { id: "T123", domain: "test" },
        view: {
          id: "V123",
          callback_id: "agent_add_modal",
          state: {},
        },
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_action).toBe("errors");
      expect(data.errors.agent_select).toBe("Missing form values");
    });

    it("returns error when agent is not selected", async () => {
      const body = buildInteractiveBody({
        type: "view_submission",
        user: { id: "U123", username: "testuser", team_id: "T123" },
        team: { id: "T123", domain: "test" },
        view: {
          id: "V123",
          callback_id: "agent_add_modal",
          state: {
            values: {
              agent_select: { agent_select_action: {} },
            },
          },
        },
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_action).toBe("errors");
      expect(data.errors.agent_select).toBe("Please select an agent");
    });

    it("returns error when agent is not found in database", async () => {
      // Use a valid UUID that doesn't exist in the database
      const body = buildInteractiveBody({
        type: "view_submission",
        user: { id: "U123", username: "testuser", team_id: "T123" },
        team: { id: "T123", domain: "test" },
        view: {
          id: "V123",
          callback_id: "agent_add_modal",
          state: {
            values: {
              agent_select: {
                agent_select_action: {
                  selected_option: {
                    value: "00000000-0000-0000-0000-000000000000",
                  },
                },
              },
            },
          },
        },
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_action).toBe("errors");
      expect(data.errors.agent_select).toContain("not found");
    });

    it("returns error when user is not linked", async () => {
      // Create a compose first so we can reference it
      const { composeId } = await context.createSlackBinding(
        // Create a user link first just to get a compose
        (await context.createSlackInstallation({ withUserLink: true })).userLink
          .id,
        { agentName: "temp-agent" },
      );

      const body = buildInteractiveBody({
        type: "view_submission",
        user: { id: "U-unlinked", username: "testuser", team_id: "T-test" },
        team: { id: "T-test", domain: "test" },
        view: {
          id: "V123",
          callback_id: "agent_add_modal",
          state: {
            values: {
              agent_select: {
                agent_select_action: { selected_option: { value: composeId } },
              },
            },
          },
        },
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_action).toBe("errors");
      expect(data.errors.agent_select).toContain("not linked");
    });

    it("returns error when agent is already added", async () => {
      const { installation, userLink } = await context.createSlackInstallation({
        withUserLink: true,
      });
      // Create a binding - this creates a compose with name "compose-existing-agent"
      // and a binding with agentName "existing-agent"
      const { composeId, agentName } = await context.createSlackBinding(
        userLink.id,
        {
          agentName: "existing-agent",
        },
      );

      // Update the binding's agentName to match the compose name (compose-existing-agent)
      // since the implementation uses compose.name as the agentName
      await globalThis.services.db
        .update(slackBindings)
        .set({ agentName: `compose-${agentName}` })
        .where(eq(slackBindings.slackUserLinkId, userLink.id));

      const body = buildInteractiveBody({
        type: "view_submission",
        user: {
          id: userLink.slackUserId,
          username: "testuser",
          team_id: installation.slackWorkspaceId,
        },
        team: { id: installation.slackWorkspaceId, domain: "test" },
        view: {
          id: "V123",
          callback_id: "agent_add_modal",
          state: {
            values: {
              agent_select: {
                agent_select_action: { selected_option: { value: composeId } },
              },
            },
          },
        },
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_action).toBe("errors");
      expect(data.errors.agent_select).toContain("already added");
    });

    it("creates binding successfully", async () => {
      const { installation, userLink } = await context.createSlackInstallation({
        withUserLink: true,
      });
      // Create a compose (via binding helper) to get a compose ID, then delete the binding
      const { composeId } = await context.createSlackBinding(userLink.id, {
        agentName: "temp-to-delete",
      });
      // Delete this binding so we can create a new one
      await globalThis.services.db
        .delete(slackBindings)
        .where(eq(slackBindings.slackUserLinkId, userLink.id));

      const body = buildInteractiveBody({
        type: "view_submission",
        user: {
          id: userLink.slackUserId,
          username: "testuser",
          team_id: installation.slackWorkspaceId,
        },
        team: { id: installation.slackWorkspaceId, domain: "test" },
        view: {
          id: "V123",
          callback_id: "agent_add_modal",
          state: {
            values: {
              agent_select: {
                agent_select_action: { selected_option: { value: composeId } },
              },
            },
          },
        },
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);

      // Success returns empty 200 to close the modal
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe("");
    });

    it("saves secrets to user scope when provided", async () => {
      const { installation, userLink } = await context.createSlackInstallation({
        withUserLink: true,
      });
      // Create a compose (via binding helper) to get a compose ID, then delete the binding
      const { composeId } = await context.createSlackBinding(userLink.id, {
        agentName: "secret-agent",
      });
      // Delete this binding so we can create a new one
      await globalThis.services.db
        .delete(slackBindings)
        .where(eq(slackBindings.slackUserLinkId, userLink.id));

      const body = buildInteractiveBody({
        type: "view_submission",
        user: {
          id: userLink.slackUserId,
          username: "testuser",
          team_id: installation.slackWorkspaceId,
        },
        team: { id: installation.slackWorkspaceId, domain: "test" },
        view: {
          id: "V123",
          callback_id: "agent_add_modal",
          state: {
            values: {
              agent_select: {
                agent_select_action: { selected_option: { value: composeId } },
              },
              secret_API_KEY: {
                value: { value: "test-api-key-value" },
              },
              secret_OTHER_SECRET: {
                value: { value: "test-other-secret" },
              },
            },
          },
        },
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);

      // Success returns empty 200 to close the modal
      expect(response.status).toBe(200);

      // Verify secrets were saved to user's scope
      const savedSecrets = await listSecrets(userLink.vm0UserId);
      const secretNames = savedSecrets.map((s) => s.name);

      expect(secretNames).toContain("API_KEY");
      expect(secretNames).toContain("OTHER_SECRET");
    });
  });

  describe("Unknown Callback", () => {
    it("returns 200 for unknown callback_id", async () => {
      const body = buildInteractiveBody({
        type: "view_submission",
        user: { id: "U123", username: "testuser", team_id: "T123" },
        team: { id: "T123", domain: "test" },
        view: {
          id: "V123",
          callback_id: "unknown_modal",
          state: { values: {} },
        },
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });
});
