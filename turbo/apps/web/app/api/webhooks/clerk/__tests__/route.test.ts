import { describe, it, expect, vi, beforeEach } from "vitest";
import { uniqueId } from "../../../../../src/__tests__/test-helpers";
import {
  createTestScopeWithClerkOrg,
  insertTestScopeMember,
  findTestScopeMember,
  countTestScopeMembersForUser,
  findTestScopeClerkOrgId,
} from "../../../../../src/__tests__/api-test-helpers";
import { POST } from "../route";
import { reloadEnv } from "../../../../../src/env";
import type { WebhookEvent } from "@clerk/nextjs/server";

// Mock verifyWebhook — we cannot generate real Svix signatures in tests
let mockVerifyResult: WebhookEvent;
vi.mock("@clerk/nextjs/webhooks", () => ({
  verifyWebhook: vi.fn(async () => mockVerifyResult),
}));

/** Wait for all after() callbacks to complete */
async function flushAfterCallbacks() {
  const callbacks = [...globalThis.nextAfterCallbacks];
  globalThis.nextAfterCallbacks = [];
  await Promise.all(callbacks.map((fn) => fn()));
}

function createRequest(): Request {
  return new Request("http://localhost:3000/api/webhooks/clerk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

beforeEach(() => {
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", "test-signing-secret");
  reloadEnv();
});

describe("POST /api/webhooks/clerk", () => {
  describe("organizationMembership.created", () => {
    it("creates scope_members record when member added to org with scope", async () => {
      const slug = uniqueId("scope");
      const clerkOrgId = uniqueId("org");
      const userId = uniqueId("user");

      const { scopeId } = await createTestScopeWithClerkOrg(slug, clerkOrgId);

      mockVerifyResult = {
        type: "organizationMembership.created",
        data: {
          organization: { id: clerkOrgId },
          public_user_data: { user_id: userId },
          role: "org:member",
        },
      } as unknown as WebhookEvent;

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      const member = await findTestScopeMember(scopeId, userId);
      expect(member).not.toBeNull();
      expect(member!.role).toBe("member");
    });

    it("creates admin scope_members record for org:admin role", async () => {
      const slug = uniqueId("scope");
      const clerkOrgId = uniqueId("org");
      const userId = uniqueId("user");

      const { scopeId } = await createTestScopeWithClerkOrg(slug, clerkOrgId);

      mockVerifyResult = {
        type: "organizationMembership.created",
        data: {
          organization: { id: clerkOrgId },
          public_user_data: { user_id: userId },
          role: "org:admin",
        },
      } as unknown as WebhookEvent;

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      const member = await findTestScopeMember(scopeId, userId);
      expect(member).not.toBeNull();
      expect(member!.role).toBe("admin");
    });

    it("returns 200 when org has no scope (no-op)", async () => {
      mockVerifyResult = {
        type: "organizationMembership.created",
        data: {
          organization: { id: "org_nonexistent" },
          public_user_data: { user_id: "user_123" },
          role: "org:member",
        },
      } as unknown as WebhookEvent;

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();
    });

    it("is idempotent when scope_members record already exists", async () => {
      const slug = uniqueId("scope");
      const clerkOrgId = uniqueId("org");
      const userId = uniqueId("user");

      const { scopeId } = await createTestScopeWithClerkOrg(slug, clerkOrgId);
      await insertTestScopeMember(scopeId, userId, "member");

      mockVerifyResult = {
        type: "organizationMembership.created",
        data: {
          organization: { id: clerkOrgId },
          public_user_data: { user_id: userId },
          role: "org:member",
        },
      } as unknown as WebhookEvent;

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      const member = await findTestScopeMember(scopeId, userId);
      expect(member).not.toBeNull();
    });
  });

  describe("organizationMembership.updated", () => {
    it("updates role when member role changes", async () => {
      const slug = uniqueId("scope");
      const clerkOrgId = uniqueId("org");
      const userId = uniqueId("user");

      const { scopeId } = await createTestScopeWithClerkOrg(slug, clerkOrgId);
      await insertTestScopeMember(scopeId, userId, "member");

      mockVerifyResult = {
        type: "organizationMembership.updated",
        data: {
          organization: { id: clerkOrgId },
          public_user_data: { user_id: userId },
          role: "org:admin",
        },
      } as unknown as WebhookEvent;

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      const member = await findTestScopeMember(scopeId, userId);
      expect(member!.role).toBe("admin");
    });

    it("is no-op when member does not exist in scope_members", async () => {
      const slug = uniqueId("scope");
      const clerkOrgId = uniqueId("org");

      await createTestScopeWithClerkOrg(slug, clerkOrgId);

      mockVerifyResult = {
        type: "organizationMembership.updated",
        data: {
          organization: { id: clerkOrgId },
          public_user_data: { user_id: "user_nonexistent" },
          role: "org:admin",
        },
      } as unknown as WebhookEvent;

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();
    });
  });

  describe("organizationMembership.deleted", () => {
    it("removes scope_members record", async () => {
      const slug = uniqueId("scope");
      const clerkOrgId = uniqueId("org");
      const userId = uniqueId("user");

      const { scopeId } = await createTestScopeWithClerkOrg(slug, clerkOrgId);
      await insertTestScopeMember(scopeId, userId, "member");

      mockVerifyResult = {
        type: "organizationMembership.deleted",
        data: {
          organization: { id: clerkOrgId },
          public_user_data: { user_id: userId },
          role: "org:member",
        },
      } as unknown as WebhookEvent;

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      const member = await findTestScopeMember(scopeId, userId);
      expect(member).toBeNull();
    });

    it("is idempotent when member does not exist", async () => {
      const slug = uniqueId("scope");
      const clerkOrgId = uniqueId("org");

      await createTestScopeWithClerkOrg(slug, clerkOrgId);

      mockVerifyResult = {
        type: "organizationMembership.deleted",
        data: {
          organization: { id: clerkOrgId },
          public_user_data: { user_id: "user_nonexistent" },
          role: "org:member",
        },
      } as unknown as WebhookEvent;

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();
    });
  });

  describe("user.deleted", () => {
    it("removes all scope_members records for the deleted user", async () => {
      const userId = uniqueId("user");

      const { scopeId: scopeId1 } = await createTestScopeWithClerkOrg(
        uniqueId("scope"),
        uniqueId("org"),
      );
      const { scopeId: scopeId2 } = await createTestScopeWithClerkOrg(
        uniqueId("scope"),
        uniqueId("org"),
      );

      await insertTestScopeMember(scopeId1, userId, "admin");
      await insertTestScopeMember(scopeId2, userId, "member");

      expect(await countTestScopeMembersForUser(userId)).toBe(2);

      mockVerifyResult = {
        type: "user.deleted",
        data: { id: userId, deleted: true, object: "user" },
      } as unknown as WebhookEvent;

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      expect(await countTestScopeMembersForUser(userId)).toBe(0);
    });

    it("is no-op when user has no scope_members", async () => {
      mockVerifyResult = {
        type: "user.deleted",
        data: { id: "user_nonexistent", deleted: true, object: "user" },
      } as unknown as WebhookEvent;

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();
    });
  });

  describe("organization.deleted", () => {
    it("orphans scope and removes members when org is deleted", async () => {
      const slug = uniqueId("scope");
      const clerkOrgId = uniqueId("org");
      const userId = uniqueId("user");

      const { scopeId } = await createTestScopeWithClerkOrg(slug, clerkOrgId);
      await insertTestScopeMember(scopeId, userId, "admin");

      mockVerifyResult = {
        type: "organization.deleted",
        data: { id: clerkOrgId, deleted: true, object: "organization" },
      } as unknown as WebhookEvent;

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      const member = await findTestScopeMember(scopeId, userId);
      expect(member).toBeNull();

      const scopeClerkOrgId = await findTestScopeClerkOrgId(scopeId);
      expect(scopeClerkOrgId).toBe(`deleted_${clerkOrgId}`);
    });

    it("is no-op when org has no scope", async () => {
      mockVerifyResult = {
        type: "organization.deleted",
        data: {
          id: "org_nonexistent",
          deleted: true,
          object: "organization",
        },
      } as unknown as WebhookEvent;

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();
    });
  });

  describe("verification and routing", () => {
    it("returns 503 when CLERK_WEBHOOK_SIGNING_SECRET is not configured", async () => {
      vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", "");
      reloadEnv();

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(503);
    });

    it("returns 400 when webhook verification fails", async () => {
      const { verifyWebhook } = await import("@clerk/nextjs/webhooks");
      (verifyWebhook as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Invalid signature"),
      );

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(400);
    });

    it("returns 200 for unrecognized event types", async () => {
      mockVerifyResult = {
        type: "session.created",
        data: {},
      } as unknown as WebhookEvent;

      const response = await POST(createRequest() as never);
      expect(response.status).toBe(200);
    });
  });
});
