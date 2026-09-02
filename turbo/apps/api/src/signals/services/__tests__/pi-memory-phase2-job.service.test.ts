/* oxlint-disable jest/prefer-expect-resolves, vitest/prefer-to-be-falsy, vitest/prefer-to-be-truthy -- Direct state-machine assertions keep each PostgreSQL transition and fence visually paired. */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { blobs } from "@okouai/db/schema/blob";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";

import { db } from "../../../lib/db";
import { commitPiMemoryStage1Candidate } from "../pi-memory-stage1-candidate.service";
import {
  advancePiMemoryPhase2InputRevision,
  claimPiMemoryPhase2Job,
  failPiMemoryPhase2Job,
  heartbeatPiMemoryPhase2Job,
  PI_MEMORY_PHASE2_RETRY_DELAY_MS,
  PI_MEMORY_PHASE2_SUCCESS_COOLDOWN_MS,
  succeedPiMemoryPhase2Job,
} from "../pi-memory-phase2-job.service";
import {
  createPhase2TestScope,
  insertPendingPhase2Job,
  insertPhase2Candidates,
  readPhase2Job,
  replacePhase2CandidateSource,
} from "./pi-memory-phase2-job.test-fixture";

const NOW = Object.freeze(new Date("2026-09-03T04:00:00.000Z"));

describe("Pi memory Phase 2 job transitions", () => {
  it("transactionally advances exactly once per fresh successful Stage 1 commit", async () => {
    const scope = await createPhase2TestScope("stage1-commit");
    const leaseExpiresAt = new Date(NOW.getTime() + 60_000);
    const leaseTokens = [randomUUID(), randomUUID(), randomUUID()];
    const hashes = await insertPhase2Candidates(scope, [
      {
        piSessionId: "session-a",
        status: "leased",
        leaseToken: leaseTokens[0],
        leaseExpiresAt,
      },
      {
        piSessionId: "session-b",
        status: "leased",
        leaseToken: leaseTokens[1],
        leaseExpiresAt,
      },
      {
        piSessionId: "session-failure",
        status: "leased",
        leaseToken: leaseTokens[2],
        leaseExpiresAt,
      },
    ]);

    const [first, second] = await Promise.all([
      db().transaction(async (tx) => {
        return await commitPiMemoryStage1Candidate(tx, {
          ...scope,
          piSessionId: "session-a",
          sourceHistoryHash: hashes[0] as string,
          leaseToken: leaseTokens[0] as string,
          committedAt: NOW,
          result: {
            kind: "succeeded",
            rawMemory: "first raw memory",
            rolloutSummary: "first summary",
          },
        });
      }),
      db().transaction(async (tx) => {
        return await commitPiMemoryStage1Candidate(tx, {
          ...scope,
          piSessionId: "session-b",
          sourceHistoryHash: hashes[1] as string,
          leaseToken: leaseTokens[1] as string,
          committedAt: NOW,
          result: { kind: "succeeded_no_output" },
        });
      }),
    ]);
    expect([first, second]).toStrictEqual([true, true]);
    expect(await readPhase2Job(scope)).toMatchObject({
      status: "pending",
      inputRevision: 2,
      completedRevision: 0,
      retryCount: 0,
    });

    const failed = await db().transaction(async (tx) => {
      return await commitPiMemoryStage1Candidate(tx, {
        ...scope,
        piSessionId: "session-failure",
        sourceHistoryHash: hashes[2] as string,
        leaseToken: leaseTokens[2] as string,
        committedAt: NOW,
        result: {
          kind: "retryable_failure",
          retryAt: new Date(NOW.getTime() + 60_000),
          errorClass: "provider_timeout",
        },
      });
    });
    expect(failed).toBe(true);
    expect((await readPhase2Job(scope))?.inputRevision).toBe(2);

    const replay = await db().transaction(async (tx) => {
      return await commitPiMemoryStage1Candidate(tx, {
        ...scope,
        piSessionId: "session-a",
        sourceHistoryHash: hashes[0] as string,
        leaseToken: leaseTokens[0] as string,
        committedAt: NOW,
        result: { kind: "succeeded_no_output" },
      });
    });
    expect(replay).toBe(false);
    expect((await readPhase2Job(scope))?.inputRevision).toBe(2);
  });

  it("rolls back Stage 1 success if enqueue cannot advance", async () => {
    const scope = await createPhase2TestScope("enqueue-rollback");
    const leaseToken = randomUUID();
    const [sourceHistoryHash] = await insertPhase2Candidates(scope, [
      {
        piSessionId: "rollback-session",
        status: "leased",
        leaseToken,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      },
    ]);
    await insertPendingPhase2Job(scope, {
      inputRevision: 2_147_483_647,
    });

    await expect(
      db().transaction(async (tx) => {
        return await commitPiMemoryStage1Candidate(tx, {
          ...scope,
          piSessionId: "rollback-session",
          sourceHistoryHash: sourceHistoryHash as string,
          leaseToken,
          committedAt: NOW,
          result: { kind: "succeeded_no_output" },
        });
      }),
    ).rejects.toThrow("Failed query");

    const [candidate] = await db()
      .select({
        status: piMemoryStage1Candidates.status,
        leaseToken: piMemoryStage1Candidates.leaseToken,
      })
      .from(piMemoryStage1Candidates)
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
          eq(piMemoryStage1Candidates.piSessionId, "rollback-session"),
        ),
      );
    expect(candidate).toStrictEqual({ status: "leased", leaseToken });
    expect((await readPhase2Job(scope))?.inputRevision).toBe(2_147_483_647);
  });

  it("commits Stage 1 successes for different Storages independently", async () => {
    const firstScope = await createPhase2TestScope("stage1-independent-a");
    const secondScope = await createPhase2TestScope("stage1-independent-b");
    const firstToken = randomUUID();
    const secondToken = randomUUID();
    const expiresAt = new Date(NOW.getTime() + 60_000);
    const [firstHashes, secondHashes] = await Promise.all([
      insertPhase2Candidates(firstScope, [
        {
          piSessionId: "independent-a",
          status: "leased",
          leaseToken: firstToken,
          leaseExpiresAt: expiresAt,
        },
      ]),
      insertPhase2Candidates(secondScope, [
        {
          piSessionId: "independent-b",
          status: "leased",
          leaseToken: secondToken,
          leaseExpiresAt: expiresAt,
        },
      ]),
    ]);

    await Promise.all([
      db().transaction(async (tx) => {
        await commitPiMemoryStage1Candidate(tx, {
          ...firstScope,
          piSessionId: "independent-a",
          sourceHistoryHash: firstHashes[0] as string,
          leaseToken: firstToken,
          committedAt: NOW,
          result: { kind: "succeeded_no_output" },
        });
      }),
      db().transaction(async (tx) => {
        await commitPiMemoryStage1Candidate(tx, {
          ...secondScope,
          piSessionId: "independent-b",
          sourceHistoryHash: secondHashes[0] as string,
          leaseToken: secondToken,
          committedAt: NOW,
          result: { kind: "succeeded_no_output" },
        });
      }),
    ]);
    expect((await readPhase2Job(firstScope))?.inputRevision).toBe(1);
    expect((await readPhase2Job(secondScope))?.inputRevision).toBe(1);
  });

  it("preserves a live lease while advancing only its input revision", async () => {
    const scope = await createPhase2TestScope("leased-advance");
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(NOW.getTime() + 60_000);
    await insertPendingPhase2Job(scope, {
      status: "leased",
      inputRevision: 1,
      claimedRevision: 1,
      leaseToken,
      leaseExpiresAt,
      retryCount: 2,
      claimedSelectionDigest: "b".repeat(64),
      claimedSelectedCount: 7,
      claimedSelectedUtf8Bytes: 99,
      updatedAt: new Date(NOW.getTime() - 1000),
    });

    await db().transaction(async (tx) => {
      await advancePiMemoryPhase2InputRevision(tx, {
        ...scope,
        enqueuedAt: NOW,
      });
    });
    expect(await readPhase2Job(scope)).toMatchObject({
      status: "leased",
      inputRevision: 2,
      completedRevision: 0,
      claimedRevision: 1,
      leaseToken,
      leaseExpiresAt,
      retryCount: 2,
      claimedSelectionDigest: "b".repeat(64),
      claimedSelectedCount: 7,
      claimedSelectedUtf8Bytes: 99,
      updatedAt: NOW,
    });
  });

  it("claims at most once per Storage while independent Storages proceed", async () => {
    const firstScope = await createPhase2TestScope("claim-race-a");
    const secondScope = await createPhase2TestScope("claim-race-b");
    await insertPendingPhase2Job(firstScope, { updatedAt: NOW });
    await insertPendingPhase2Job(secondScope, { updatedAt: NOW });

    const sameStorage = await Promise.all([
      claimPiMemoryPhase2Job(db(), {
        currentTime: NOW,
        scope: firstScope,
      }),
      claimPiMemoryPhase2Job(db(), {
        currentTime: NOW,
        scope: firstScope,
      }),
    ]);
    expect(sameStorage.filter(Boolean)).toHaveLength(1);

    const independent = await claimPiMemoryPhase2Job(db(), {
      currentTime: NOW,
      scope: secondScope,
    });
    expect(independent).toMatchObject(secondScope);
  });

  it("enforces lease fences, retry boundaries, attempt limits, and new-input reset", async () => {
    const scope = await createPhase2TestScope("fences");
    await insertPendingPhase2Job(scope);
    const claimed = await claimPiMemoryPhase2Job(db(), {
      currentTime: NOW,
      scope,
    });
    expect(claimed).not.toBeNull();
    if (!claimed) {
      throw new Error("Expected a claimed job");
    }

    expect(
      await heartbeatPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken: randomUUID(),
        claimedRevision: claimed.claimedRevision,
        currentTime: new Date(NOW.getTime() + 1000),
      }),
    ).toBe(false);
    expect(
      await heartbeatPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken: claimed.leaseToken,
        claimedRevision: claimed.claimedRevision,
        currentTime: claimed.leaseExpiresAt,
      }),
    ).toBe(false);
    expect(
      await heartbeatPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken: claimed.leaseToken,
        claimedRevision: claimed.claimedRevision,
        currentTime: new Date(NOW.getTime() + 1000),
      }),
    ).toBe(true);

    const failedAt = new Date(NOW.getTime() + 2000);
    expect(
      await failPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken: randomUUID(),
        claimedRevision: claimed.claimedRevision,
        currentTime: failedAt,
        errorClass: "provider_timeout",
      }),
    ).toBe(false);
    expect(
      await failPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken: claimed.leaseToken,
        claimedRevision: claimed.claimedRevision,
        currentTime: failedAt,
        errorClass: "provider_timeout",
      }),
    ).toBe(true);
    expect(await readPhase2Job(scope)).toMatchObject({
      status: "retryable_failure",
      retryCount: 1,
      retryAt: new Date(failedAt.getTime() + PI_MEMORY_PHASE2_RETRY_DELAY_MS),
      lastErrorClass: "provider_timeout",
    });

    expect(
      await claimPiMemoryPhase2Job(db(), {
        currentTime: new Date(
          failedAt.getTime() + PI_MEMORY_PHASE2_RETRY_DELAY_MS - 1,
        ),
        scope,
      }),
    ).toBeNull();
    const retryAt = new Date(
      failedAt.getTime() + PI_MEMORY_PHASE2_RETRY_DELAY_MS,
    );
    const second = await claimPiMemoryPhase2Job(db(), {
      currentTime: retryAt,
      scope,
    });
    expect(second).not.toBeNull();
    if (!second) {
      throw new Error("Expected second attempt");
    }
    await failPiMemoryPhase2Job(db(), {
      ...scope,
      leaseToken: second.leaseToken,
      claimedRevision: second.claimedRevision,
      currentTime: new Date(retryAt.getTime() + 1),
      errorClass: "provider_timeout",
    });
    const thirdAt = new Date(
      retryAt.getTime() + 1 + PI_MEMORY_PHASE2_RETRY_DELAY_MS,
    );
    const third = await claimPiMemoryPhase2Job(db(), {
      currentTime: thirdAt,
      scope,
    });
    expect(third).not.toBeNull();
    if (!third) {
      throw new Error("Expected third attempt");
    }
    await failPiMemoryPhase2Job(db(), {
      ...scope,
      leaseToken: third.leaseToken,
      claimedRevision: third.claimedRevision,
      currentTime: new Date(thirdAt.getTime() + 1),
      errorClass: "provider_timeout",
    });
    expect(await readPhase2Job(scope)).toMatchObject({
      status: "terminal_failure",
      retryCount: 3,
      retryAt: null,
      lastErrorClass: "provider_timeout",
    });

    const enqueuedAt = new Date(thirdAt.getTime() + 2);
    await db().transaction(async (tx) => {
      await advancePiMemoryPhase2InputRevision(tx, { ...scope, enqueuedAt });
    });
    expect(await readPhase2Job(scope)).toMatchObject({
      status: "pending",
      inputRevision: 2,
      retryCount: 0,
      lastErrorClass: null,
    });
  });

  it("rejects every wrong or expired fence without changing job or markers", async () => {
    const scope = await createPhase2TestScope("rejected-fences");
    const [sourceHistoryHash] = await insertPhase2Candidates(scope, [
      { piSessionId: "fenced-candidate" },
    ]);
    await db()
      .update(piMemoryStage1Candidates)
      .set({ lastSelectedSourceHistoryHash: sourceHistoryHash as string })
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
          eq(piMemoryStage1Candidates.piSessionId, "fenced-candidate"),
        ),
      );
    await insertPendingPhase2Job(scope);
    const claimed = await claimPiMemoryPhase2Job(db(), {
      currentTime: NOW,
      scope,
    });
    expect(claimed).not.toBeNull();
    if (!claimed) {
      throw new Error("Expected fenced claim");
    }
    const before = await readPhase2Job(scope);
    const invalidFences = [
      { ...scope, orgId: `${scope.orgId}-wrong` },
      { ...scope, userId: `${scope.userId}-wrong` },
      { ...scope, memoryStorageId: randomUUID() },
      { ...scope, leaseToken: randomUUID() },
      { ...scope, claimedRevision: claimed.claimedRevision + 1 },
      { ...scope, currentTime: claimed.leaseExpiresAt },
    ];
    for (const invalid of invalidFences) {
      const fence = {
        ...scope,
        leaseToken: claimed.leaseToken,
        claimedRevision: claimed.claimedRevision,
        currentTime: new Date(NOW.getTime() + 1),
        ...invalid,
      };
      expect(await heartbeatPiMemoryPhase2Job(db(), fence)).toBe(false);
      expect(
        await failPiMemoryPhase2Job(db(), {
          ...fence,
          errorClass: "rejected_fence",
        }),
      ).toBe(false);
      expect(
        await succeedPiMemoryPhase2Job(db(), {
          ...fence,
          selected: claimed.selected,
        }),
      ).toBe(false);
    }
    expect(await readPhase2Job(scope)).toStrictEqual(before);

    await db().transaction(async (tx) => {
      await advancePiMemoryPhase2InputRevision(tx, {
        ...scope,
        enqueuedAt: new Date(NOW.getTime() + 2),
      });
    });
    expect(
      await failPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken: claimed.leaseToken,
        claimedRevision: claimed.claimedRevision,
        currentTime: new Date(NOW.getTime() + 3),
        errorClass: "old_revision_failed",
      }),
    ).toBe(true);
    expect(await readPhase2Job(scope)).toMatchObject({
      status: "pending",
      inputRevision: 2,
      completedRevision: 0,
      retryCount: 0,
      lastErrorClass: null,
    });
    const [marker] = await db()
      .select({
        value: piMemoryStage1Candidates.lastSelectedSourceHistoryHash,
      })
      .from(piMemoryStage1Candidates)
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
          eq(piMemoryStage1Candidates.piSessionId, "fenced-candidate"),
        ),
      );
    expect(marker?.value).toBe(sourceHistoryHash);
  });

  it("counts stale lease takeovers and resets attempts for newer input", async () => {
    const scope = await createPhase2TestScope("stale-takeover");
    await insertPendingPhase2Job(scope);
    const first = await claimPiMemoryPhase2Job(db(), {
      currentTime: NOW,
      scope,
    });
    expect(first).not.toBeNull();
    if (!first) {
      throw new Error("Expected initial claim");
    }
    const firstExpiry = first.leaseExpiresAt;
    const second = await claimPiMemoryPhase2Job(db(), {
      currentTime: firstExpiry,
      scope,
    });
    expect(second?.leaseToken).not.toBe(first.leaseToken);
    expect((await readPhase2Job(scope))?.retryCount).toBe(1);

    await db().transaction(async (tx) => {
      await advancePiMemoryPhase2InputRevision(tx, {
        ...scope,
        enqueuedAt: new Date(firstExpiry.getTime() + 1),
      });
    });
    const third = await claimPiMemoryPhase2Job(db(), {
      currentTime: second?.leaseExpiresAt ?? new Date(0),
      scope,
    });
    expect(third?.claimedRevision).toBe(2);
    expect((await readPhase2Job(scope))?.retryCount).toBe(0);
    if (!second || !third) {
      throw new Error("Expected both takeover claims");
    }
    expect(
      await heartbeatPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken: second.leaseToken,
        claimedRevision: second.claimedRevision,
        currentTime: new Date(second.leaseExpiresAt.getTime() - 1),
      }),
    ).toBe(false);
    expect(
      await failPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken: second.leaseToken,
        claimedRevision: second.claimedRevision,
        currentTime: new Date(second.leaseExpiresAt.getTime() - 1),
        errorClass: "stale_owner",
      }),
    ).toBe(false);
    expect(
      await succeedPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken: second.leaseToken,
        claimedRevision: second.claimedRevision,
        currentTime: new Date(second.leaseExpiresAt.getTime() - 1),
        selected: second.selected,
      }),
    ).toBe(false);
    expect((await readPhase2Job(scope))?.leaseToken).toBe(third.leaseToken);
  });

  it("honors the exact six-hour success cooldown boundary", async () => {
    const scope = await createPhase2TestScope("cooldown");
    await insertPendingPhase2Job(scope, {
      inputRevision: 2,
      completedRevision: 1,
      lastSucceededAt: NOW,
    });
    expect(
      await claimPiMemoryPhase2Job(db(), {
        currentTime: new Date(
          NOW.getTime() + PI_MEMORY_PHASE2_SUCCESS_COOLDOWN_MS - 1,
        ),
        scope,
      }),
    ).toBeNull();
    expect(
      await claimPiMemoryPhase2Job(db(), {
        currentTime: new Date(
          NOW.getTime() + PI_MEMORY_PHASE2_SUCCESS_COOLDOWN_MS,
        ),
        scope,
      }),
    ).not.toBeNull();
  });

  it("finalizes only the frozen tuple set and preserves newer input", async () => {
    const scope = await createPhase2TestScope("success");
    const oldHash = (
      await insertPhase2Candidates(scope, [
        {
          piSessionId: "old-unselected",
          sourceCompletedAt: new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000),
        },
      ])
    )[0] as string;
    await db()
      .update(piMemoryStage1Candidates)
      .set({ lastSelectedSourceHistoryHash: oldHash })
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
          eq(piMemoryStage1Candidates.piSessionId, "old-unselected"),
        ),
      );
    await insertPhase2Candidates(scope, [
      { piSessionId: "selected-a", rawMemory: "A" },
      { piSessionId: "selected-b", rawMemory: "BB" },
    ]);
    await insertPendingPhase2Job(scope);
    const claimed = await claimPiMemoryPhase2Job(db(), {
      currentTime: NOW,
      scope,
    });
    expect(
      claimed?.selected.map((candidate) => {
        return candidate.piSessionId;
      }),
    ).toStrictEqual(["selected-a", "selected-b"]);
    if (!claimed) {
      throw new Error("Expected selection claim");
    }

    expect(
      await succeedPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken: claimed.leaseToken,
        claimedRevision: claimed.claimedRevision,
        currentTime: new Date(NOW.getTime() + 1),
        selected: [...claimed.selected].reverse(),
      }),
    ).toBe(false);
    await replacePhase2CandidateSource({
      scope,
      piSessionId: "selected-a",
      sourceCompletedAt: new Date(NOW.getTime() + 2),
    });
    await db().transaction(async (tx) => {
      await advancePiMemoryPhase2InputRevision(tx, {
        ...scope,
        enqueuedAt: new Date(NOW.getTime() + 2),
      });
    });
    expect(
      await succeedPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken: claimed.leaseToken,
        claimedRevision: claimed.claimedRevision,
        currentTime: new Date(NOW.getTime() + 3),
        selected: claimed.selected,
      }),
    ).toBe(true);

    expect(await readPhase2Job(scope)).toMatchObject({
      status: "pending",
      inputRevision: 2,
      completedRevision: 1,
      claimedRevision: null,
      retryCount: 0,
      lastSucceededAt: new Date(NOW.getTime() + 3),
    });
    const markers = await db()
      .select({
        piSessionId: piMemoryStage1Candidates.piSessionId,
        sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
        marker: piMemoryStage1Candidates.lastSelectedSourceHistoryHash,
      })
      .from(piMemoryStage1Candidates)
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
          eq(piMemoryStage1Candidates.orgId, scope.orgId),
          eq(piMemoryStage1Candidates.userId, scope.userId),
        ),
      );
    expect(
      Object.fromEntries(
        markers.map((candidate) => {
          return [candidate.piSessionId, candidate.marker];
        }),
      ),
    ).toStrictEqual({
      "old-unselected": null,
      "selected-a": null,
      "selected-b": markers.find((row) => {
        return row.piSessionId === "selected-b";
      })?.sourceHistoryHash,
    });
  });

  it("accepts an empty selection and clears every old marker", async () => {
    const scope = await createPhase2TestScope("empty-success");
    const [oldHash] = await insertPhase2Candidates(scope, [
      {
        piSessionId: "old-marker",
        sourceCompletedAt: new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000),
      },
    ]);
    await db()
      .update(piMemoryStage1Candidates)
      .set({ lastSelectedSourceHistoryHash: oldHash as string })
      .where(
        eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
      );
    await insertPendingPhase2Job(scope);
    const claimed = await claimPiMemoryPhase2Job(db(), {
      currentTime: NOW,
      scope,
    });
    expect(claimed?.selected).toStrictEqual([]);
    if (!claimed) {
      throw new Error("Expected empty selection claim");
    }
    expect(
      await succeedPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken: claimed.leaseToken,
        claimedRevision: claimed.claimedRevision,
        currentTime: new Date(NOW.getTime() + 1),
        selected: [],
      }),
    ).toBe(true);
    expect(await readPhase2Job(scope)).toMatchObject({
      status: "idle",
      inputRevision: 1,
      completedRevision: 1,
    });
    const [candidate] = await db()
      .select({
        marker: piMemoryStage1Candidates.lastSelectedSourceHistoryHash,
      })
      .from(piMemoryStage1Candidates)
      .where(
        eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
      );
    expect(candidate?.marker).toBeNull();
  });

  it("cascades control state without deleting the referenced history blob", async () => {
    const scope = await createPhase2TestScope("delete-cascade");
    const [hash] = await insertPhase2Candidates(scope, [
      { piSessionId: "retained-history" },
    ]);
    await insertPendingPhase2Job(scope);
    await db().delete(storages).where(eq(storages.id, scope.memoryStorageId));

    expect(await readPhase2Job(scope)).toBeUndefined();
    const [candidate] = await db()
      .select()
      .from(piMemoryStage1Candidates)
      .where(
        eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
      );
    expect(candidate).toBeUndefined();
    const [historyBlob] = await db()
      .select({ hash: blobs.hash })
      .from(blobs)
      .where(eq(blobs.hash, hash as string));
    expect(historyBlob).toStrictEqual({ hash });
  });
});
