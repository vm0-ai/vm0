import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { POST } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import {
  createTestCompose,
  listTestSecrets,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  givenLinkedSlackUser,
  givenUserHasAgent,
} from "../../../../../src/__tests__/slack/api-helpers";

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
      // Create a linked user to get a valid compose
      const { userLink } = await givenLinkedSlackUser();
      mockClerk({ userId: userLink.vm0UserId });
      const { composeId } = await createTestCompose("unlinked-test");

      // Submit from a different, unlinked Slack user
      const body = buildInteractiveBody({
        type: "view_submission",
        user: { id: "U-unlinked", username: "testuser", team_id: "T-unlinked" },
        team: { id: "T-unlinked", domain: "test" },
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
      // Create linked user with an agent binding
      const { userLink, installation } = await givenLinkedSlackUser();
      const { compose } = await givenUserHasAgent(userLink, {
        agentName: "existing-agent",
      });

      // Try to add the same compose again
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
                agent_select_action: {
                  selected_option: { value: compose.id },
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
      expect(data.errors.agent_select).toContain("already added");
    });

    it("creates binding successfully", async () => {
      const { userLink, installation } = await givenLinkedSlackUser();
      mockClerk({ userId: userLink.vm0UserId });
      const { composeId } = await createTestCompose("new-agent");

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
      const { userLink, installation } = await givenLinkedSlackUser();
      mockClerk({ userId: userLink.vm0UserId });
      const { composeId } = await createTestCompose("secret-agent");

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

      // Verify secrets were saved via API
      const savedSecrets = await listTestSecrets();
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
