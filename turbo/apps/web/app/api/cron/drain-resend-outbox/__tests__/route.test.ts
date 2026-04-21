import { describe, it, expect, beforeEach, vi } from "vitest";
import { Resend } from "resend";
import { GET } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../src/env";
import { uniqueId } from "../../../../../src/__tests__/test-helpers";
import {
  insertTestContactMapping,
  insertTestContactOutboxItem,
  clearTestContactOutboxByPrefix,
  clearTestContactMappingByPrefix,
} from "../../../../../src/__tests__/db-test-seeders/resend-contact";
import {
  findTestContactMapping,
  findTestContactOutboxById,
} from "../../../../../src/__tests__/db-test-assertions/resend-contact";

const TEST_PREFIX = "drain-";
const context = testContext();
const mockResend = vi.mocked(new Resend(""), true);
const cronSecret = "test-cron-secret";
const segmentId = "seg_test_123";

function cronRequest(secret?: string) {
  return createTestRequest(
    "http://localhost:3000/api/cron/drain-resend-outbox",
    secret ? { headers: { Authorization: `Bearer ${secret}` } } : undefined,
  );
}

// Drain sleeps 500ms between items; with cumulative outbox rows across
// sequential tests and parallel worker contention on the shared DB,
// a single drain call can take well over 5s.
describe("GET /api/cron/drain-resend-outbox", { timeout: 60000 }, () => {
  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("CRON_SECRET", cronSecret);
    vi.stubEnv("RESEND_CONTACT_SEGMENT_ID", segmentId);
    reloadEnv();

    await clearTestContactOutboxByPrefix(TEST_PREFIX);
    await clearTestContactMappingByPrefix(TEST_PREFIX);

    // Return a deterministic contact id based on the email, so assertions
    // don't rely on call order (parallel workers may drain their rows
    // through this worker's mock).
    mockResend.contacts.create.mockImplementation((options: unknown) => {
      const email = (options as { email: string }).email;
      return Promise.resolve({
        data: { id: `contact_for_${email}` },
        error: null,
      }) as never;
    });
    mockResend.contacts.update.mockResolvedValue({
      data: { id: "contact_updated" },
      error: null,
    } as never);
    mockResend.contacts.remove.mockResolvedValue({
      data: { deleted: true, contact: "removed" },
      error: null,
    } as never);
    mockResend.contacts.get.mockResolvedValue({
      data: { id: "contact_lookup", email: "lookup@example.com" },
      error: null,
    } as never);
  });

  describe("Authentication", () => {
    it("rejects missing cron secret", async () => {
      const response = await GET(cronRequest());
      expect(response.status).toBe(401);
    });
  });

  describe("Feature gate", () => {
    it("short-circuits when RESEND_CONTACT_SEGMENT_ID unset", async () => {
      vi.stubEnv("RESEND_CONTACT_SEGMENT_ID", "");
      reloadEnv();

      const response = await GET(cronRequest(cronSecret));

      expect(response.status).toBe(200);
      expect(mockResend.contacts.create).not.toHaveBeenCalled();
    });
  });

  describe("Create op", () => {
    it("calls Resend create with the correct email and segment", async () => {
      const clerkUserId = uniqueId("drain-create");
      const email = `${clerkUserId}@example.com`;
      await insertTestContactOutboxItem({
        op: "create",
        clerkUserId,
        email,
        firstName: "Alice",
      });

      await GET(cronRequest(cronSecret));

      // Mapping write is covered by the 409 test below (same upsert path).
      // Checking only the outbound call here keeps this test resilient to
      // cross-worker DB timing in parallel vitest runs.
      expect(mockResend.contacts.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email,
          segments: [{ id: segmentId }],
        }),
      );
    });

    it("recovers mapping via getContactByEmail on 409 already-exists", async () => {
      const clerkUserId = uniqueId("drain-409");
      const email = `${clerkUserId}@example.com`;
      await insertTestContactOutboxItem({ op: "create", clerkUserId, email });

      mockResend.contacts.create.mockImplementation((options: unknown) => {
        const input = options as { email: string };
        if (input.email === email) {
          return Promise.resolve({
            data: null,
            error: {
              message: "contact already exists",
              statusCode: 409,
              name: "validation_error",
            },
          }) as never;
        }
        return Promise.resolve({
          data: { id: `contact_for_${input.email}` },
          error: null,
        }) as never;
      });
      mockResend.contacts.get.mockImplementation((options: unknown) => {
        const input = options as { email: string };
        if (input.email === email) {
          return Promise.resolve({
            data: { id: "contact_existing_999", email },
            error: null,
          }) as never;
        }
        return Promise.resolve({
          data: { id: "contact_lookup", email: input.email },
          error: null,
        }) as never;
      });

      await GET(cronRequest(cronSecret));

      const mapping = await findTestContactMapping(clerkUserId);
      expect(mapping?.resendContactId).toBe("contact_existing_999");
    });

    it("retries with backoff on 429 rate-limit", async () => {
      const clerkUserId = uniqueId("drain-429");
      const email = `${clerkUserId}@example.com`;
      const { id: itemId } = await insertTestContactOutboxItem({
        op: "create",
        clerkUserId,
        email,
      });

      mockResend.contacts.create.mockImplementation((options: unknown) => {
        const input = options as { email: string };
        if (input.email === email) {
          return Promise.resolve({
            data: null,
            error: {
              message: "rate limit",
              statusCode: 429,
              name: "rate_limit_exceeded",
            },
          }) as never;
        }
        return Promise.resolve({
          data: { id: `contact_for_${input.email}` },
          error: null,
        }) as never;
      });

      await GET(cronRequest(cronSecret));

      const row = await findTestContactOutboxById(itemId);
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(1);
      expect(row?.nextRetryAt).toBeInstanceOf(Date);
      expect(row?.lastError).toContain("rate limit");
    });
  });

  describe("Delete op", () => {
    it("removes contact and deletes mapping on success", async () => {
      const clerkUserId = uniqueId("drain-del");
      await insertTestContactMapping({
        clerkUserId,
        resendContactId: "contact_to_delete",
        lastEmail: `${clerkUserId}@example.com`,
      });
      await insertTestContactOutboxItem({ op: "delete", clerkUserId });

      await GET(cronRequest(cronSecret));

      expect(mockResend.contacts.remove).toHaveBeenCalledWith(
        "contact_to_delete",
      );

      const mapping = await findTestContactMapping(clerkUserId);
      expect(mapping).toBeNull();
    });

    it("treats 404 as idempotent success and clears mapping", async () => {
      const clerkUserId = uniqueId("drain-del-404");
      await insertTestContactMapping({
        clerkUserId,
        resendContactId: "contact_already_gone",
        lastEmail: `${clerkUserId}@example.com`,
      });
      await insertTestContactOutboxItem({ op: "delete", clerkUserId });

      mockResend.contacts.remove.mockImplementation((contactId: unknown) => {
        if (contactId === "contact_already_gone") {
          return Promise.resolve({
            data: null,
            error: {
              message: "not found",
              statusCode: 404,
              name: "not_found",
            },
          }) as never;
        }
        return Promise.resolve({
          data: { deleted: true, contact: contactId as string },
          error: null,
        }) as never;
      });

      await GET(cronRequest(cronSecret));

      const mapping = await findTestContactMapping(clerkUserId);
      expect(mapping).toBeNull();
    });
  });
});
