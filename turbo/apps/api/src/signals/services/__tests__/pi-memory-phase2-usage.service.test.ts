import { randomUUID } from "node:crypto";

import { usageEvent } from "@okouai/db/schema/usage-event";
import { and, eq } from "drizzle-orm";
import { onTestFinished, describe, expect, it } from "vitest";

import { db } from "../../../lib/db";
import {
  PI_MEMORY_PHASE2_MODEL,
  recordPiMemoryPhase2Usage,
} from "../pi-memory-phase2-usage.service";

describe("Pi memory Phase 2 usage", () => {
  it("persists one owner-scoped runless ledger set idempotently", async () => {
    const memoryStorageId = randomUUID();
    const orgId = `phase2-usage-org-${randomUUID()}`;
    const userId = `phase2-usage-user-${randomUUID()}`;
    const args = {
      memoryStorageId,
      claimedRevision: 7,
      selectionDigest: "a".repeat(64),
      orgId,
      userId,
      responseId: "phase2-response-31291",
      usage: {
        input: 101,
        output: 29,
        cacheRead: 17,
        cacheWrite: 11,
        reasoning: 13,
      },
    } as const;
    onTestFinished(async () => {
      await db()
        .delete(usageEvent)
        .where(and(eq(usageEvent.orgId, orgId), eq(usageEvent.userId, userId)));
    });

    await recordPiMemoryPhase2Usage(db(), args);
    await recordPiMemoryPhase2Usage(db(), args);

    const rows = await db()
      .select({
        runId: usageEvent.runId,
        orgId: usageEvent.orgId,
        userId: usageEvent.userId,
        provider: usageEvent.provider,
        category: usageEvent.category,
        quantity: usageEvent.quantity,
      })
      .from(usageEvent)
      .where(and(eq(usageEvent.orgId, orgId), eq(usageEvent.userId, userId)));
    expect(rows).toHaveLength(4);
    expect(rows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "tokens.input", quantity: 101 }),
        expect.objectContaining({ category: "tokens.output", quantity: 29 }),
        expect.objectContaining({
          category: "tokens.cache_read",
          quantity: 17,
        }),
        expect.objectContaining({
          category: "tokens.cache_creation",
          quantity: 11,
        }),
      ]),
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        runId: null,
        orgId,
        userId,
        provider: PI_MEMORY_PHASE2_MODEL,
      });
    }
  });
});
