import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { and, eq, like, or } from "drizzle-orm";

import { db } from "../lib/db";

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
