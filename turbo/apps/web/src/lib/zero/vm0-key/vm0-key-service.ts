import { and, eq, sql } from "drizzle-orm";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";

/**
 * Get a random API key from the VM0 key pool for the given vendor and model.
 * When a model is provided, prefer an exact match before falling back to the vendor pool.
 * Returns both the key and the associated model (some vendors have model-specific keys).
 * Returns null when no keys exist for the vendor.
 */
export async function getVm0ApiKey(
  vendor: string,
  model?: string,
): Promise<{ apiKey: string; model: string } | null> {
  if (model) {
    const [exactModelRow] = await globalThis.services.db
      .select({
        apiKey: vm0ApiKeys.apiKey,
        model: vm0ApiKeys.model,
      })
      .from(vm0ApiKeys)
      .where(and(eq(vm0ApiKeys.vendor, vendor), eq(vm0ApiKeys.model, model)))
      .orderBy(sql`random()`)
      .limit(1);

    if (exactModelRow) {
      return { apiKey: exactModelRow.apiKey, model: exactModelRow.model };
    }
  }

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
