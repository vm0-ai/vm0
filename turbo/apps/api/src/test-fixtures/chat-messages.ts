import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { and, eq, like, or, sql } from "drizzle-orm";

import { db } from "../lib/db";
import { createDeferredPromise } from "../signals/utils";

/**
 * BDD-scoped vm0 managed key prefixes. Fixture writes below only ever touch
 * rows whose api_key carries one of these prefixes, so concurrent test files
 * cannot clobber real seed data or each other's non-bdd rows.
 */
const VM0_BDD_API_KEY_PREFIXES = [
  "vm0-key-bdd-fake-",
  "vm0-key-bdd-dev-seed-",
] as const;

function bddVm0ApiKeyFilter(vendor: string, model: string) {
  const [fakePrefix, devSeedPrefix] = VM0_BDD_API_KEY_PREFIXES;
  return and(
    eq(vm0ApiKeys.vendor, vendor),
    eq(vm0ApiKeys.model, model),
    or(
      like(vm0ApiKeys.apiKey, `${fakePrefix}%`),
      like(vm0ApiKeys.apiKey, `${devSeedPrefix}%`),
    ),
  );
}

/**
 * Replaces the bdd-scoped rows of the platform-managed vm0 API key pool for
 * one vendor/model.
 *
 * Why product APIs cannot construct this state: vm0_api_keys is a
 * platform-operations table with no product write surface — keys are
 * provisioned out of band. Keys passed here must carry a
 * VM0_BDD_API_KEY_PREFIXES prefix so only bdd rows are touched.
 */
export async function replaceBddVm0ApiKeys(args: {
  readonly vendor: string;
  readonly model: string;
  readonly keys: readonly { readonly apiKey: string; readonly label: string }[];
}): Promise<void> {
  for (const key of args.keys) {
    const scoped = VM0_BDD_API_KEY_PREFIXES.some((prefix) => {
      return key.apiKey.length > prefix.length && key.apiKey.startsWith(prefix);
    });
    if (!scoped) {
      throw new Error(
        `replaceBddVm0ApiKeys: api key must start with one of ${VM0_BDD_API_KEY_PREFIXES.join(", ")}`,
      );
    }
  }
  await db().transaction(async (tx) => {
    await tx
      .delete(vm0ApiKeys)
      .where(bddVm0ApiKeyFilter(args.vendor, args.model));
    if (args.keys.length > 0) {
      await tx.insert(vm0ApiKeys).values(
        args.keys.map((key) => {
          return {
            vendor: args.vendor,
            model: args.model,
            apiKey: key.apiKey,
            label: key.label,
          };
        }),
      );
    }
  });
}

/**
 * Deletes the bdd-scoped rows of the platform-managed vm0 API key pool for
 * one vendor/model. See replaceBddVm0ApiKeys for why no product API exists.
 */
export async function deleteBddVm0ApiKeys(args: {
  readonly vendor: string;
  readonly model: string;
}): Promise<void> {
  await db()
    .delete(vm0ApiKeys)
    .where(bddVm0ApiKeyFilter(args.vendor, args.model));
}

/**
 * Checks the operator-managed label for a key returned through a public test
 * entry point. The key pool has no product read surface, and local dev seeds
 * may contain additional valid keys for the same vendor and model.
 */
export async function hasVm0ApiKeyLabel(args: {
  readonly vendor: string;
  readonly model: string;
  readonly apiKey: string;
  readonly label: string;
}): Promise<boolean> {
  const rows = await db()
    .select({ id: vm0ApiKeys.id })
    .from(vm0ApiKeys)
    .where(
      and(
        eq(vm0ApiKeys.vendor, args.vendor),
        eq(vm0ApiKeys.model, args.model),
        eq(vm0ApiKeys.apiKey, args.apiKey),
        eq(vm0ApiKeys.label, args.label),
      ),
    )
    .limit(1);
  return rows.length === 1;
}

/**
 * Holds the production org admission advisory lock and reports its waiter
 * count. No product API exposes database lock timing, so this fixture is the
 * narrow boundary exception for the queue-drain concurrency test.
 */
export async function holdOrgAdmissionLockFixture(args: {
  readonly orgId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly waiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const result = await tx.execute<{ readonly pid: number }>(sql`
      SELECT
        pg_backend_pid() AS "pid",
        pg_advisory_xact_lock(hashtext(${args.orgId}))
    `);
    const holderPid = result.rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the admission lock holder pid");
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
      const result = await db().execute<{ readonly waiterCount: number }>(sql`
        SELECT count(*)::int AS "waiterCount"
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
      `);
      return result.rows[0]?.waiterCount ?? 0;
    },
  };
}
