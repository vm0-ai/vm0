import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@react-email/components";
import type { CreateEmailOptions } from "resend";
import { Resend } from "resend";
import { testContext } from "../../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestAgentSession,
} from "../../../../__tests__/api-test-helpers";
import {
  createTestEmailThreadSession,
  insertTestOutboxItem,
} from "../../../../__tests__/db-test-seeders/email";
import {
  findTestEmailThreadSession,
  findTestOutboxItems,
  findTestOutboxItemById,
} from "../../../../__tests__/db-test-assertions/email";
import { uniqueId } from "../../../../__tests__/test-helpers";
import { generateReplyToken } from "../handlers/shared";
import {
  enqueueEmail,
  drainById,
  drainBatch,
  cleanupExpiredOutbox,
} from "../outbox-service";
import type { EnqueueEmailOptions } from "../types";

const context = testContext();
const mockResend = vi.mocked(new Resend(""), true);

function baseEmail(
  overrides?: Partial<EnqueueEmailOptions>,
): EnqueueEmailOptions {
  return {
    from: "Zero <test-org@vm7.bot>",
    to: "user@example.com",
    subject: "Test email",
    template: {
      template: "agent-reply",
      props: {
        agentName: "test-agent",
        output: "Hello!",
        logsUrl: "https://example.com/logs",
      },
    },
    ...overrides,
  };
}

describe("outbox-service", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
    mockResend.emails.send.mockClear();
    mockResend.emails.get.mockClear();
    // Default: send succeeds
    mockResend.emails.send.mockResolvedValue({
      data: { id: `resend-${Date.now()}` },
      error: null,
    } as never);
    mockResend.emails.get.mockResolvedValue({
      data: {
        id: "mock-email-id",
        message_id: "<mock-message-id@vm7.bot>",
      },
      error: null,
    } as never);
    // No clearEmailOutbox — use ID-based assertions to avoid cross-worker interference
  });

  describe("enqueueEmail", () => {
    it("should insert a row and drain inline on success", async () => {
      const uniqueSubject = `Enqueue test ${Date.now()}`;
      await enqueueEmail(baseEmail({ subject: uniqueSubject }));

      // Resend was called with our email
      expect(mockResend.emails.send).toHaveBeenCalled();
    });

    it("should keep item as pending when inline drain fails", async () => {
      const uniqueSubject = `Pending test ${Date.now()}`;
      mockResend.emails.send.mockResolvedValueOnce({
        data: null,
        error: {
          message: "Too many requests",
          name: "rate_limit_exceeded",
          statusCode: 429,
        },
      } as never);

      await enqueueEmail(baseEmail({ subject: uniqueSubject }));

      // Find our specific item by subject (avoid count-based assertions)
      const pending = await findTestOutboxItems("pending");
      const ours = pending.find((i) => {
        return i.subject === uniqueSubject;
      });
      expect(ours).toBeDefined();
      expect(ours!.attempts).toBe(1);
      expect(ours!.lastError).toContain("Too many requests");
      expect(ours!.nextRetryAt).not.toBeNull();
    });
  });

  describe("drainById", () => {
    it("should send email and mark as sent", async () => {
      const { id } = await insertTestOutboxItem({
        fromAddress: "agent@vm7.bot",
        toAddresses: "user@example.com",
        subject: "Direct insert",
        template: {
          template: "agent-reply",
          props: {
            agentName: "test",
            output: "test output",
            logsUrl: "https://x.com",
          },
        },
      });

      const drained = await drainById(id);
      expect(drained).toBe(true);
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
    });

    it("should retry on failure with exponential backoff", async () => {
      mockResend.emails.send.mockResolvedValue({
        data: null,
        error: {
          message: "rate limited",
          name: "rate_limit_exceeded",
          statusCode: 429,
        },
      } as never);

      const { id } = await insertTestOutboxItem({
        fromAddress: "agent@vm7.bot",
        toAddresses: "user@example.com",
        subject: "Retry test",
        template: {
          template: "inbound-error",
          props: { errorMessage: "err" },
        },
      });

      await drainById(id);

      // Should be back to pending with retry scheduled
      const item = await findTestOutboxItemById(id);
      expect(item).not.toBeNull();
      expect(item!.status).toBe("pending");
      expect(item!.attempts).toBe(1);
      expect(item!.nextRetryAt).not.toBeNull();
      // First backoff: 1s
      const backoffMs = item!.nextRetryAt!.getTime() - Date.now();
      expect(backoffMs).toBeLessThan(2000);
      expect(backoffMs).toBeGreaterThan(-500);
    });

    it("should mark as permanently failed after max attempts", async () => {
      mockResend.emails.send.mockResolvedValue({
        data: null,
        error: {
          message: "permanent failure",
          name: "validation_error",
          statusCode: 422,
        },
      } as never);

      const { id } = await insertTestOutboxItem({
        fromAddress: "agent@vm7.bot",
        toAddresses: "user@example.com",
        subject: "Perm fail test",
        template: {
          template: "inbound-error",
          props: { errorMessage: "err" },
        },
        attempts: 2, // Already tried twice, next will be 3rd = max
      });

      await drainById(id);

      const item = await findTestOutboxItemById(id);
      expect(item).not.toBeNull();
      expect(item!.status).toBe("failed");
      expect(item!.attempts).toBe(3);
      expect(item!.lastError).toBe("permanent failure");
    });
  });

  describe("drainBatch", () => {
    it("should process multiple pending items", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { id } = await insertTestOutboxItem({
          fromAddress: "agent@vm7.bot",
          toAddresses: `batch-user${i}@example.com`,
          subject: `Batch item ${i}`,
          template: {
            template: "inbound-error",
            props: { errorMessage: "err" },
          },
        });
        ids.push(id);
      }

      await drainBatch();

      // Verify all our specific items are sent (regardless of other concurrent items)
      for (const id of ids) {
        const item = await findTestOutboxItemById(id);
        expect(item).not.toBeNull();
        expect(item!.status).toBe("sent");
        expect(item!.resendId).toBeTruthy();
      }
    });
  });

  describe("cleanupExpiredOutbox", () => {
    it("should remove items older than TTL", async () => {
      // Insert an old pending item (20 min ago)
      const oldDate = new Date(Date.now() - 20 * 60 * 1000);
      const { id: oldId } = await insertTestOutboxItem({
        fromAddress: "agent@vm7.bot",
        toAddresses: "user@example.com",
        subject: "Old expired",
        template: {
          template: "inbound-error",
          props: { errorMessage: "err" },
        },
        attempts: 3,
        createdAt: oldDate,
      });

      // Insert a recent pending item (should NOT be cleaned)
      const { id: recentId } = await insertTestOutboxItem({
        fromAddress: "agent@vm7.bot",
        toAddresses: "user@example.com",
        subject: "Recent pending",
        template: {
          template: "inbound-error",
          props: { errorMessage: "err" },
        },
      });

      await cleanupExpiredOutbox();

      // Old item should be deleted
      const oldItem = await findTestOutboxItemById(oldId);
      expect(oldItem).toBeNull();

      // Recent item should still exist
      const recentItem = await findTestOutboxItemById(recentId);
      expect(recentItem).not.toBeNull();
      expect(recentItem!.subject).toBe("Recent pending");
    });

    it("should not remove sent items", async () => {
      const oldDate = new Date(Date.now() - 20 * 60 * 1000);
      const { id } = await insertTestOutboxItem({
        fromAddress: "agent@vm7.bot",
        toAddresses: "user@example.com",
        subject: "Old sent",
        template: {
          template: "inbound-error",
          props: { errorMessage: "err" },
        },
        status: "sent",
        attempts: 1,
        resendId: "re_123",
        createdAt: oldDate,
      });

      await cleanupExpiredOutbox();

      // Sent item should still exist
      const item = await findTestOutboxItemById(id);
      expect(item).not.toBeNull();
      expect(item!.subject).toBe("Old sent");
    });
  });

  describe("agent-reply markdown rendering", () => {
    it("renders markdown output as structural HTML tags", async () => {
      const { id } = await insertTestOutboxItem({
        fromAddress: "agent@vm7.bot",
        toAddresses: "user@example.com",
        subject: "Markdown test",
        template: {
          template: "agent-reply",
          props: {
            agentName: "test-agent",
            output: "## Hello\n\nThis is **bold** and `code`.",
            logsUrl: "https://example.com/logs",
          },
        },
      });

      await drainById(id);

      const sentCall = mockResend.emails.send.mock.calls[0];
      expect(sentCall).toBeDefined();
      const payload: CreateEmailOptions = sentCall![0];
      expect(payload).toHaveProperty("react");
      if (!("react" in payload) || payload.react == null) {
        throw new Error("Expected react property on email payload");
      }
      const html = await render(payload.react);

      expect(html).toContain("<h2");
      expect(html).toContain("<strong");
      expect(html).toContain("<code");
    });
  });

  describe("post-send actions", () => {
    it("should not call getMessageId when no threadAction", async () => {
      const { id } = await insertTestOutboxItem({
        fromAddress: "agent@vm7.bot",
        toAddresses: "user@example.com",
        subject: "No action",
        template: {
          template: "inbound-error",
          props: { errorMessage: "err" },
        },
      });

      await drainById(id);

      // emails.send called, but emails.get should NOT be called (no threading needed)
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      expect(mockResend.emails.get).not.toHaveBeenCalled();
    });

    it("should save new thread session on save_thread_session action", async () => {
      const user = await context.setupUser({ prefix: "outbox-save" });
      const { composeId, agentId } = await createTestCompose(
        uniqueId("outbox-agent"),
      );
      const agentSession = await createTestAgentSession(user.userId, composeId);
      const replyToken = generateReplyToken(agentSession.id);

      const { id } = await insertTestOutboxItem({
        fromAddress: "agent@vm7.bot",
        toAddresses: "user@example.com",
        subject: "Save thread",
        template: {
          template: "agent-reply",
          props: {
            agentName: "test",
            output: "Hello",
            logsUrl: "https://example.com",
          },
        },
        postSendAction: {
          action: "save_thread_session",
          userId: user.userId,
          agentId,
          agentSessionId: agentSession.id,
          replyToToken: replyToken,
        },
      });

      await drainById(id);

      // getMessageId should have been called for threading
      expect(mockResend.emails.get).toHaveBeenCalledTimes(1);

      // Thread session should have been created with the message ID
      const session = await findTestEmailThreadSession(replyToken);
      expect(session).not.toBeNull();
      expect(session!.lastEmailMessageId).toBe("<mock-message-id@vm7.bot>");
    });

    it("should update existing thread session on update_thread_session action", async () => {
      const user = await context.setupUser({ prefix: "outbox-update" });
      const { composeId, agentId } = await createTestCompose(
        uniqueId("outbox-agent"),
      );
      const agentSession = await createTestAgentSession(user.userId, composeId);
      const replyToken = generateReplyToken(agentSession.id);

      // Create an existing thread session
      const emailSession = await createTestEmailThreadSession({
        userId: user.userId,
        agentId,
        agentSessionId: agentSession.id,
        replyToToken: replyToken,
        lastEmailMessageId: "<old-msg@vm7.bot>",
      });

      const { id } = await insertTestOutboxItem({
        fromAddress: "agent@vm7.bot",
        toAddresses: "user@example.com",
        subject: "Update thread",
        template: {
          template: "agent-reply",
          props: {
            agentName: "test",
            output: "Reply",
            logsUrl: "https://example.com",
          },
        },
        postSendAction: {
          action: "update_thread_session",
          sessionId: emailSession.id,
        },
      });

      await drainById(id);

      // getMessageId should have been called
      expect(mockResend.emails.get).toHaveBeenCalledTimes(1);

      // Thread session should have been updated with the new message ID
      const updated = await findTestEmailThreadSession(replyToken);
      expect(updated).not.toBeNull();
      expect(updated!.lastEmailMessageId).toBe("<mock-message-id@vm7.bot>");
    });
  });
});
