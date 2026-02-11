import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { POST as createCompose } from "../../composes/route";
import { POST as createOrg } from "../../../org/route";
import {
  createTestRequest,
  addTestOrgMember,
  createDefaultComposeConfig,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("Agent Runs with Organization Scope", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("running agents in org scope", () => {
    it("should allow owner to run agent in org scope", async () => {
      const ownerId = `owner-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const orgSlug = `test-org-${Date.now()}`;
      const createOrgRequest = createTestRequest(
        "http://localhost:3000/api/org",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: orgSlug }),
        },
      );
      await createOrg(createOrgRequest);

      // Create compose in org scope
      const agentName = `org-agent-${Date.now()}`;
      const config = createDefaultComposeConfig(agentName);
      const createComposeRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vm0-scope": orgSlug,
          },
          body: JSON.stringify({ content: config }),
        },
      );
      const composeResponse = await createCompose(createComposeRequest);
      const compose = await composeResponse.json();

      // Run agent in org scope
      const runRequest = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vm0-scope": orgSlug,
          },
          body: JSON.stringify({
            agentComposeId: compose.composeId,
            prompt: "Test prompt",
          }),
        },
      );
      const response = await POST(runRequest);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.runId).toBeDefined();
      // In test environment, run may fail due to missing runner, but 201 indicates access was granted
      expect(["pending", "running", "failed"]).toContain(data.status);
    });

    it("should allow member to run agent created by owner", async () => {
      const ownerId = `owner-${Date.now()}`;
      const memberId = `member-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const orgSlug = `test-org-${Date.now()}`;
      const createOrgRequest = createTestRequest(
        "http://localhost:3000/api/org",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: orgSlug }),
        },
      );
      const orgResponse = await createOrg(createOrgRequest);
      const org = await orgResponse.json();

      // Owner creates compose in org scope
      const agentName = `shared-agent-${Date.now()}`;
      const config = createDefaultComposeConfig(agentName);
      const createComposeRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vm0-scope": orgSlug,
          },
          body: JSON.stringify({ content: config }),
        },
      );
      const composeResponse = await createCompose(createComposeRequest);
      const compose = await composeResponse.json();

      // Add member
      await addTestOrgMember(org.id, memberId, "member");

      // Member runs the agent
      mockClerk({ userId: memberId });
      const runRequest = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vm0-scope": orgSlug,
          },
          body: JSON.stringify({
            agentComposeId: compose.composeId,
            prompt: "Test prompt from member",
          }),
        },
      );
      const response = await POST(runRequest);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.runId).toBeDefined();
      // In test environment, run may fail due to missing runner, but 201 indicates access was granted
      expect(["pending", "running", "failed"]).toContain(data.status);
    });

    it("should allow owner to run agent created by member", async () => {
      const ownerId = `owner-${Date.now()}`;
      const memberId = `member-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const orgSlug = `test-org-${Date.now()}`;
      const createOrgRequest = createTestRequest(
        "http://localhost:3000/api/org",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: orgSlug }),
        },
      );
      const orgResponse = await createOrg(createOrgRequest);
      const org = await orgResponse.json();

      // Add member
      await addTestOrgMember(org.id, memberId, "member");

      // Member creates compose in org scope
      mockClerk({ userId: memberId });
      const agentName = `member-agent-${Date.now()}`;
      const config = createDefaultComposeConfig(agentName);
      const createComposeRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vm0-scope": orgSlug,
          },
          body: JSON.stringify({ content: config }),
        },
      );
      const composeResponse = await createCompose(createComposeRequest);
      const compose = await composeResponse.json();

      // Owner runs the agent created by member
      mockClerk({ userId: ownerId });
      const runRequest = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vm0-scope": orgSlug,
          },
          body: JSON.stringify({
            agentComposeId: compose.composeId,
            prompt: "Test prompt from owner",
          }),
        },
      );
      const response = await POST(runRequest);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.runId).toBeDefined();
      // In test environment, run may fail due to missing runner, but 201 indicates access was granted
      expect(["pending", "running", "failed"]).toContain(data.status);
    });

    it("should reject non-member from running org agent", async () => {
      const ownerId = `owner-${Date.now()}`;
      const nonMemberId = `non-member-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const orgSlug = `test-org-${Date.now()}`;
      const createOrgRequest = createTestRequest(
        "http://localhost:3000/api/org",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: orgSlug }),
        },
      );
      await createOrg(createOrgRequest);

      // Owner creates compose in org scope
      const agentName = `private-agent-${Date.now()}`;
      const config = createDefaultComposeConfig(agentName);
      const createComposeRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vm0-scope": orgSlug,
          },
          body: JSON.stringify({ content: config }),
        },
      );
      const composeResponse = await createCompose(createComposeRequest);
      const compose = await composeResponse.json();

      // Non-member tries to run the agent
      mockClerk({ userId: nonMemberId });
      const runRequest = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vm0-scope": orgSlug,
          },
          body: JSON.stringify({
            agentComposeId: compose.composeId,
            prompt: "Test prompt from non-member",
          }),
        },
      );
      const response = await POST(runRequest);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.message).toContain("Access denied");
    });

    it("should allow member to run org agent without scope header (via compose ID)", async () => {
      const ownerId = `owner-${Date.now()}`;
      const memberId = `member-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const orgSlug = `test-org-${Date.now()}`;
      const createOrgRequest = createTestRequest(
        "http://localhost:3000/api/org",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: orgSlug }),
        },
      );
      const orgResponse = await createOrg(createOrgRequest);
      const org = await orgResponse.json();

      // Owner creates compose in org scope
      const agentName = `org-only-agent-${Date.now()}`;
      const config = createDefaultComposeConfig(agentName);
      const createComposeRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vm0-scope": orgSlug,
          },
          body: JSON.stringify({ content: config }),
        },
      );
      const composeResponse = await createCompose(createComposeRequest);
      const compose = await composeResponse.json();

      // Add member
      await addTestOrgMember(org.id, memberId, "member");

      // Member runs without scope header - should succeed via compose ID permission check
      mockClerk({ userId: memberId });
      const runRequest = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // No x-vm0-scope header - runs API uses compose ID for permission check
          },
          body: JSON.stringify({
            agentComposeId: compose.composeId,
            prompt: "Test prompt without scope",
          }),
        },
      );
      const response = await POST(runRequest);
      const data = await response.json();

      // Should succeed - runs API checks compose access via canAccessCompose
      // which grants access to org members
      expect(response.status).toBe(201);
      expect(data.runId).toBeDefined();
    });
  });
});
