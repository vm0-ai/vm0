import { eq, sql } from "drizzle-orm";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";

/**
 * Get a random API key from the VM0 key pool for the given vendor.
 * Returns both the key and the associated model (some vendors have model-specific keys).
 * Returns null when no keys exist for the vendor.
 */
export async function getVm0ApiKey(
  vendor: string,
): Promise<{ apiKey: string; model: string } | null> {
  const [row] = await globalThis.services.db
    .select({
      apiKey: vm0ApiKeys.apiKey,
      model: vm0ApiKeys.model,
    })
    .from(vm0ApiKeys)
    .where(eq(vm0ApiKeys.vendor, vendor))
    .orderBy(sql`random()`)
    .limit(1);

  if (!row) {
    return null;
  }

  return { apiKey: row.apiKey, model: row.model };
}
