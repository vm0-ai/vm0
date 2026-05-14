import { randomUUID } from "node:crypto";

import { cronDrainEmailOutboxContract } from "@vm0/api-contracts/contracts/cron";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { createStore, command } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, nowDate } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const resendMocks = context.mocks.resend;
const FIXED_NOW_MS = Date.UTC(2026, 4, 14, 12, 0, 0);

type OutboxStatus = "pending" | "sent" | "failed";

const deleteOutboxRow$ = command(
  async ({ set }, id: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    await db.delete(emailOutbox).where(eq(emailOutbox.id, id));
    signal.throwIfAborted();
  },
);

function apiClient() {
  return setupApp({ context })(cronDrainEmailOutboxContract);
}

function cronHeaders(secret = "test-cron-secret") {
  return { authorization: `Bearer ${secret}` };
}

function oldOutboxDate(): Date {
  const date = nowDate();
  date.setTime(date.getTime() - 20 * 60 * 1000);
  return date;
}

async function insertOutboxItem(args?: {
  readonly status?: OutboxStatus;
  readonly createdAt?: Date;
  readonly resendId?: string;
}): Promise<string> {
  const db = store.set(writeDb$);
  const [row] = await db
    .insert(emailOutbox)
    .values({
      fromAddress: "Zero <vm0@mail.example.com>",
      toAddresses: `drain-${randomUUID()}@example.com`,
      subject: `Cron drain test ${randomUUID()}`,
      template: {
        template: "inbound-error",
        props: { errorMessage: "err" },
      },
      status: args?.status ?? "pending",
      attempts: args?.status === "failed" ? 3 : 0,
      resendId: args?.resendId,
      createdAt: args?.createdAt,
    })
    .returning({ id: emailOutbox.id });

  if (!row) {
    throw new Error("insertOutboxItem: insert returned no row");
  }

  return row.id;
}

async function cleanupOutboxItem(id: string): Promise<void> {
  await store.set(deleteOutboxRow$, id, context.signal);
}

async function findOutboxItem(id: string): Promise<{
  readonly status: string;
  readonly attempts: number;
  readonly resendId: string | null;
} | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      status: emailOutbox.status,
      attempts: emailOutbox.attempts,
      resendId: emailOutbox.resendId,
    })
    .from(emailOutbox)
    .where(eq(emailOutbox.id, id))
    .limit(1);
  return row ?? null;
}

describe("GET /api/cron/drain-email-outbox", () => {
  const track = createFixtureTracker<string>(cleanupOutboxItem);

  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockEnv("RESEND_API_KEY", "test-resend-key");
    mockNow(FIXED_NOW_MS);
    resendMocks.send.mockReset();
    resendMocks.get.mockReset();
    resendMocks.send.mockResolvedValue({
      data: { id: `resend-${randomUUID()}` },
    });
    resendMocks.get.mockResolvedValue({
      data: { message_id: "<sent@example.com>" },
    });
  });

  afterEach(() => {
    clearMockNow();
  });

  it("rejects requests with an invalid cron secret", async () => {
    const response = await accept(
      apiClient().drain({ headers: cronHeaders("wrong-secret") }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("rejects requests with no authorization header", async () => {
    const response = await accept(apiClient().drain({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("accepts requests with the valid cron secret", async () => {
    const response = await accept(
      apiClient().drain({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.success).toBeTruthy();
    expect(typeof response.body.drained).toBe("number");
    expect(typeof response.body.cleaned).toBe("number");
  });

  it("drains pending outbox items through Resend", async () => {
    const itemId = await track(insertOutboxItem());

    const response = await accept(
      apiClient().drain({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.drained).toBeGreaterThanOrEqual(1);
    expect(resendMocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Zero <vm0@mail.example.com>",
        subject: expect.stringContaining("Cron drain test"),
        html: expect.stringContaining("err"),
      }),
    );
    await expect(findOutboxItem(itemId)).resolves.toMatchObject({
      status: "sent",
      attempts: 1,
      resendId: expect.stringMatching(/^resend-/),
    });
  });

  it("cleans up expired failed items but preserves sent items", async () => {
    const expiredId = await track(
      insertOutboxItem({
        status: "failed",
        createdAt: oldOutboxDate(),
      }),
    );
    const sentId = await track(
      insertOutboxItem({
        status: "sent",
        createdAt: oldOutboxDate(),
        resendId: "resend-old",
      }),
    );

    const response = await accept(
      apiClient().drain({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBeGreaterThanOrEqual(1);
    await expect(findOutboxItem(expiredId)).resolves.toBeNull();
    await expect(findOutboxItem(sentId)).resolves.toMatchObject({
      status: "sent",
      resendId: "resend-old",
    });
  });
});
