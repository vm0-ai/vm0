import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { createDeferredPromise } from "../../utils";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";

const context = testContext();
const outbox = createEmailOutboxStateApi(context);

function fixtureAddress(): string {
  return `email-outbox-${randomUUID()}@example.test`;
}

function fixtureSubject(): string {
  return `Email outbox fixture ${randomUUID()}`;
}

async function seedItem(options: {
  readonly status: "pending" | "failed";
  readonly createdAt: Date;
}) {
  const toAddress = fixtureAddress();
  const subject = fixtureSubject();
  const item = await outbox.seedItem({
    toAddress,
    subject,
    ...options,
  });
  onTestFinished(async () => {
    await outbox.deleteItems([item.id]);
  });
  return { ...item, toAddress, subject };
}

beforeEach(() => {
  context.mocks.resend.send.mockReset();
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `resend-${randomUUID()}` },
    error: null,
  });
  mockEnv("RESEND_FROM_DOMAIN", "vm0.bot");
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
});

describe("scoped email outbox drain", () => {
  it("drains and expires only explicitly selected items", async () => {
    const createdAt = nowDate();
    const expiredAt = new Date(0);
    const [dueItem, unrelatedDueSentinel, expiredPending, expiredFailed] =
      await Promise.all([
        seedItem({ status: "pending", createdAt }),
        seedItem({ status: "pending", createdAt }),
        seedItem({ status: "pending", createdAt: expiredAt }),
        seedItem({ status: "failed", createdAt: expiredAt }),
      ]);
    const unrelatedExpiredSentinel = await seedItem({
      status: "failed",
      createdAt: expiredAt,
    });

    const drained = await outbox.drainItems([dueItem.id]);

    expect(drained).toBe(1);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(context.mocks.resend.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Okou <okou@okou.io>",
        to: dueItem.toAddress,
        subject: dueItem.subject,
      }),
    );
    expect((await outbox.readItem(dueItem.id))?.status).toBe("sent");
    expect((await outbox.readItem(unrelatedDueSentinel.id))?.status).toBe(
      "pending",
    );
    expect((await outbox.readItem(unrelatedExpiredSentinel.id))?.status).toBe(
      "failed",
    );

    const cleaned = await outbox.cleanupExpiredItems([
      expiredPending.id,
      expiredFailed.id,
    ]);

    expect(cleaned).toBe(2);
    await expect(outbox.readItem(expiredPending.id)).resolves.toBeNull();
    await expect(outbox.readItem(expiredFailed.id)).resolves.toBeNull();
    expect((await outbox.readItem(unrelatedDueSentinel.id))?.status).toBe(
      "pending",
    );
    expect((await outbox.readItem(unrelatedExpiredSentinel.id))?.status).toBe(
      "failed",
    );
  });

  it("skips a selected item already locked by another drain", async () => {
    const toAddress = fixtureAddress();
    const subject = fixtureSubject();
    const seeded = await outbox.seedItem({
      toAddress,
      subject,
      status: "pending",
      createdAt: nowDate(),
    });
    const item = await outbox.findItem({ toAddress, subject });
    expect(item.id).toBe(seeded.id);

    const sendStarted = createDeferredPromise<void>(context.signal);
    const releaseSend = createDeferredPromise<void>(context.signal);
    onTestFinished(async () => {
      if (!releaseSend.settled()) {
        releaseSend.resolve(undefined);
      }
      await outbox.deleteItems([item.id]);
    });
    context.mocks.resend.send.mockImplementation(async () => {
      sendStarted.resolve(undefined);
      await releaseSend.promise;
      return { data: { id: "resend-scoped-lock" }, error: null };
    });

    const firstDrain = outbox.drainItems([item.id]);
    await sendStarted.promise;

    await expect(outbox.drainItems([item.id])).resolves.toBe(0);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);

    releaseSend.resolve(undefined);
    await expect(firstDrain).resolves.toBe(1);
    expect((await outbox.readItem(item.id))?.status).toBe("sent");
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
  });
});
