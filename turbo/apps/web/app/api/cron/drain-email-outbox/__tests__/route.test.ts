import { describe, it, expect, beforeEach, vi } from "vitest";
import { Resend } from "resend";
import { GET } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { insertTestOutboxItem } from "../../../../../src/__tests__/db-test-seeders/email";
import { findTestOutboxItemById } from "../../../../../src/__tests__/db-test-assertions/email";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../src/env";

const context = testContext();
const mockResend = vi.mocked(new Resend(""), true);

const cronSecret = "test-cron-secret";

function cronRequest(secret?: string) {
  return createTestRequest(
    "http://localhost:3000/api/cron/drain-email-outbox",
    secret ? { headers: { Authorization: `Bearer ${secret}` } } : undefined,
  );
}

describe("GET /api/cron/drain-email-outbox", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
    vi.stubEnv("CRON_SECRET", cronSecret);
    reloadEnv();

    mockResend.emails.send.mockClear();
    mockResend.emails.get.mockClear();
    mockResend.emails.send.mockResolvedValue({
      data: { id: `resend-${Date.now()}` },
      error: null,
    } as never);
    mockResend.emails.get.mockResolvedValue({
      data: { id: "mock-email-id", message_id: "<mock-msg@vm7.bot>" },
      error: null,
    } as never);
    // No clearEmailOutbox — avoid cross-worker interference with parallel tests
  });

  describe("Authentication", () => {
    it("should reject request without cron secret", async () => {
      const response = await GET(cronRequest());

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("should reject request with invalid cron secret", async () => {
      const response = await GET(cronRequest("wrong-secret"));

      expect(response.status).toBe(401);
    });

    it("should accept request with valid cron secret", async () => {
      const response = await GET(cronRequest(cronSecret));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(typeof data.drained).toBe("number");
      expect(typeof data.cleaned).toBe("number");
    });
  });

  describe("Drain", () => {
    it("should drain pending outbox items and call Resend", async () => {
      await insertTestOutboxItem({
        fromAddress: "agent@vm7.bot",
        toAddresses: "user@example.com",
        subject: "Cron drain test",
        template: {
          template: "inbound-error",
          props: { errorMessage: "err" },
        },
      });

      const response = await GET(cronRequest(cronSecret));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.drained).toBeGreaterThanOrEqual(1);
      expect(mockResend.emails.send).toHaveBeenCalled();
    });
  });

  describe("Cleanup", () => {
    it("should clean up expired failed items but preserve sent items", async () => {
      const oldDate = new Date(Date.now() - 20 * 60 * 1000);
      const { id: expiredId } = await insertTestOutboxItem({
        fromAddress: "agent@vm7.bot",
        toAddresses: "user@example.com",
        subject: "Expired failed item",
        template: {
          template: "inbound-error",
          props: { errorMessage: "err" },
        },
        status: "failed",
        attempts: 3,
        createdAt: oldDate,
      });

      const { id: sentId } = await insertTestOutboxItem({
        fromAddress: "agent@vm7.bot",
        toAddresses: "user@example.com",
        subject: "Old sent item",
        template: {
          template: "inbound-error",
          props: { errorMessage: "err" },
        },
        status: "sent",
        resendId: "re_old",
        createdAt: oldDate,
      });

      const response = await GET(cronRequest(cronSecret));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBeGreaterThanOrEqual(1);

      // Expired failed item should be deleted
      const expired = await findTestOutboxItemById(expiredId);
      expect(expired).toBeNull();

      // Old sent item should NOT be deleted (cleanup only removes pending/failed)
      const sent = await findTestOutboxItemById(sentId);
      expect(sent).not.toBeNull();
    });
  });
});
