import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { GET } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../src/env";
import { uniqueId } from "../../../../../src/__tests__/test-helpers";
import {
  insertTestContactMapping,
  clearTestContactOutboxByPrefix,
  clearTestContactMappingByPrefix,
} from "../../../../../src/__tests__/db-test-seeders/resend-contact";
import { findTestContactOutboxByClerkUserId } from "../../../../../src/__tests__/db-test-assertions/resend-contact";

const TEST_PREFIX = "reconcile-";
const context = testContext();
const cronSecret = "test-cron-secret";
const segmentId = "seg_test_123";

function cronRequest(secret?: string) {
  return createTestRequest(
    "http://localhost:3000/api/cron/reconcile-resend-contacts",
    secret ? { headers: { Authorization: `Bearer ${secret}` } } : undefined,
  );
}

function stubClerkUsers(
  users: Array<{
    id: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  }>,
) {
  const mockGetUserList = vi
    .fn()
    .mockImplementation(({ offset }: { offset: number }) => {
      if (offset > 0) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: users.map((u) => {
          return {
            id: u.id,
            emailAddresses: [{ id: "e1", emailAddress: u.email }],
            primaryEmailAddressId: "e1",
            firstName: u.firstName ?? null,
            lastName: u.lastName ?? null,
          };
        }),
      });
    });

  vi.mocked(clerkClient).mockResolvedValue({
    users: { getUserList: mockGetUserList },
  } as unknown as Awaited<ReturnType<typeof clerkClient>>);

  return mockGetUserList;
}

describe("GET /api/cron/reconcile-resend-contacts", () => {
  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("CRON_SECRET", cronSecret);
    vi.stubEnv("RESEND_CONTACT_SEGMENT_ID", segmentId);
    reloadEnv();

    // Prefix-scoped cleanup so parallel worker files are unaffected and
    // prior tests in this file start each run fresh.
    await clearTestContactOutboxByPrefix(TEST_PREFIX);
    await clearTestContactMappingByPrefix(TEST_PREFIX);
  });

  describe("Authentication", () => {
    it("rejects missing cron secret", async () => {
      const response = await GET(cronRequest());
      expect(response.status).toBe(401);
    });

    it("rejects wrong cron secret", async () => {
      const response = await GET(cronRequest("nope"));
      expect(response.status).toBe(401);
    });
  });

  describe("Feature gate", () => {
    it("short-circuits when RESEND_CONTACT_SEGMENT_ID unset", async () => {
      vi.stubEnv("RESEND_CONTACT_SEGMENT_ID", "");
      reloadEnv();

      const response = await GET(cronRequest(cronSecret));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skipped).toBe(true);
      expect(data.clerkUsersScanned).toBe(0);
    });
  });

  describe("Reconcile", () => {
    it("enqueues create ops for new Clerk users (first-run backfill)", async () => {
      const userId = uniqueId("reconcile-new");
      const email = `${userId}@example.com`;
      stubClerkUsers([
        { id: userId, email, firstName: "New", lastName: "User" },
      ]);

      const response = await GET(cronRequest(cronSecret));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.created).toBeGreaterThanOrEqual(1);

      const outbox = await findTestContactOutboxByClerkUserId(userId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.op).toBe("create");
      expect(outbox[0]!.email).toBe(email);
      expect(outbox[0]!.firstName).toBe("New");
    });

    it("skips users whose email/name is unchanged (diff filter)", async () => {
      const userId = uniqueId("reconcile-same");
      const email = `${userId}@example.com`;

      await insertTestContactMapping({
        clerkUserId: userId,
        resendContactId: "contact_existing",
        lastEmail: email,
        lastFirstName: "Same",
        lastLastName: "Name",
      });

      stubClerkUsers([
        { id: userId, email, firstName: "Same", lastName: "Name" },
      ]);

      await GET(cronRequest(cronSecret));

      const outbox = await findTestContactOutboxByClerkUserId(userId);
      expect(outbox).toHaveLength(0);
    });

    it("enqueues update op when email changes", async () => {
      const userId = uniqueId("reconcile-upd");
      const oldEmail = `${userId}-old@example.com`;
      const newEmail = `${userId}-new@example.com`;

      await insertTestContactMapping({
        clerkUserId: userId,
        resendContactId: "contact_existing",
        lastEmail: oldEmail,
        lastFirstName: "Same",
        lastLastName: "Name",
      });

      stubClerkUsers([
        { id: userId, email: newEmail, firstName: "Same", lastName: "Name" },
      ]);

      const response = await GET(cronRequest(cronSecret));
      const data = await response.json();
      expect(data.updated).toBeGreaterThanOrEqual(1);

      const outbox = await findTestContactOutboxByClerkUserId(userId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.op).toBe("update");
      expect(outbox[0]!.email).toBe(newEmail);
    });

    it("enqueues delete op for mappings not in Clerk", async () => {
      const userId = uniqueId("reconcile-gone");
      await insertTestContactMapping({
        clerkUserId: userId,
        resendContactId: "contact_gone",
        lastEmail: `${userId}@example.com`,
      });

      stubClerkUsers([]);

      const response = await GET(cronRequest(cronSecret));
      const data = await response.json();
      expect(data.deleted).toBeGreaterThanOrEqual(1);

      const outbox = await findTestContactOutboxByClerkUserId(userId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.op).toBe("delete");
    });
  });
});
