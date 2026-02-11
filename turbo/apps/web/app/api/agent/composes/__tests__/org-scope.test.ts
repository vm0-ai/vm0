import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { GET as getCompose } from "../[id]/route";
import { GET as listComposes } from "../list/route";
import { POST as createOrg } from "../../../org/route";
import {
  createTestRequest,
  addTestOrgMember,
  createDefaultComposeConfig,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("Agent Compose with Organization Scope", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("creating composes in org scope", () => {
    it("should create compose in organization scope", async () => {
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
      const request = createTestRequest(
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
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.name).toBe(agentName);
      expect(data.composeId).toBeDefined();
    });

    it("should allow org member to create compose in org scope", async () => {
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
      const request = createTestRequest(
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
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.name).toBe(agentName);
    });

    it("should reject non-member from creating compose in org scope", async () => {
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

      // Non-member tries to create compose in org scope
      mockClerk({ userId: nonMemberId });
      const agentName = `blocked-agent-${Date.now()}`;
      const config = createDefaultComposeConfig(agentName);
      const request = createTestRequest(
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
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.message).toContain("don't have access");
    });
  });

  describe("accessing org composes", () => {
    it("should allow org member to access compose created by another member", async () => {
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
      const createRequest = createTestRequest(
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
      const createResponse = await POST(createRequest);
      const compose = await createResponse.json();

      // Add member
      await addTestOrgMember(org.id, memberId, "member");

      // Member accesses the compose
      mockClerk({ userId: memberId });
      const getRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${compose.composeId}`,
        {
          headers: {
            "x-vm0-scope": orgSlug,
          },
        },
      );
      const response = await getCompose(getRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.name).toBe(agentName);
    });

    it("should reject non-member from accessing org compose", async () => {
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
      const createRequest = createTestRequest(
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
      const createResponse = await POST(createRequest);
      const compose = await createResponse.json();

      // Non-member tries to access the compose
      mockClerk({ userId: nonMemberId });
      const getRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${compose.composeId}`,
        {
          headers: {
            "x-vm0-scope": orgSlug,
          },
        },
      );
      const response = await getCompose(getRequest);
      const data = await response.json();

      // Returns 404 instead of 403 to avoid leaking existence information
      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });
  });

  describe("listing org composes", () => {
    it("should list composes only from current org scope", async () => {
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
      const orgAgentName = `org-agent-${Date.now()}`;
      const orgConfig = createDefaultComposeConfig(orgAgentName);
      const orgCreateRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vm0-scope": orgSlug,
          },
          body: JSON.stringify({ content: orgConfig }),
        },
      );
      await POST(orgCreateRequest);

      // Create compose in personal scope (no scope header)
      const personalAgentName = `personal-agent-${Date.now()}`;
      const personalConfig = createDefaultComposeConfig(personalAgentName);
      const personalCreateRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: personalConfig }),
        },
      );
      await POST(personalCreateRequest);

      // List composes in org scope
      const listRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes/list",
        {
          headers: {
            "x-vm0-scope": orgSlug,
          },
        },
      );
      const response = await listComposes(listRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.composes).toHaveLength(1);
      expect(data.composes[0].name).toBe(orgAgentName);
    });

    it("should allow member to see all org composes", async () => {
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
      const ownerAgentName = `owner-agent-${Date.now()}`;
      const ownerConfig = createDefaultComposeConfig(ownerAgentName);
      const ownerCreateRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vm0-scope": orgSlug,
          },
          body: JSON.stringify({ content: ownerConfig }),
        },
      );
      await POST(ownerCreateRequest);

      // Add member
      await addTestOrgMember(org.id, memberId, "member");

      // Member creates compose in org scope
      mockClerk({ userId: memberId });
      const memberAgentName = `member-agent-${Date.now()}`;
      const memberConfig = createDefaultComposeConfig(memberAgentName);
      const memberCreateRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vm0-scope": orgSlug,
          },
          body: JSON.stringify({ content: memberConfig }),
        },
      );
      await POST(memberCreateRequest);

      // Member lists all org composes
      const listRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes/list",
        {
          headers: {
            "x-vm0-scope": orgSlug,
          },
        },
      );
      const response = await listComposes(listRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.composes).toHaveLength(2);
      const names = data.composes.map((c: { name: string }) => c.name);
      expect(names).toContain(ownerAgentName);
      expect(names).toContain(memberAgentName);
    });
  });
});
