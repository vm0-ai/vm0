import { count, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { lockUsageEventCompaction } from "../signals/services/usage-event-compaction-lock.service";
import { createDeferredPromise } from "../signals/utils";

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });

/**
 * Holds the production usage-compaction advisory lock so route tests can prove
 * that destructive cleanup waits for the same transaction boundary.
 */
export async function holdUsageEventCompactionLockFixture(
  signal: AbortSignal,
): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly waiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    await lockUsageEventCompaction(tx);
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the usage compaction lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    waiterCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_locks AS waiting
          WHERE waiting.locktype = 'advisory'
            AND NOT waiting.granted
            AND (waiting.classid, waiting.objid, waiting.objsubid) IN (
              SELECT held.classid, held.objid, held.objsubid
              FROM pg_locks AS held
              WHERE held.locktype = 'advisory'
                AND held.pid = ${holderPid}
                AND held.granted
            )
        `,
        waiterCountRowSchema,
      );
      return rows[0]?.waiterCount ?? 0;
    },
  };
}
