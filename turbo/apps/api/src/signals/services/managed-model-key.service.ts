import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";

type ManagedModelKeyWriter = Pick<Db, "insert">;

interface ManagedModelKeyInput {
  readonly vendor: string;
  readonly apiKey: string;
  readonly label: string | null;
}

interface ManagedModelKeyIdentity {
  readonly id: string;
  readonly vendor: string;
  readonly revision: number;
}

/**
 * Atomically preserves key identity and advances revision only on rotation.
 */
export async function upsertManagedModelKey(
  db: ManagedModelKeyWriter,
  input: ManagedModelKeyInput,
): Promise<ManagedModelKeyIdentity> {
  const [row] = await db
    .insert(builtInModelKeys)
    .values(input)
    .onConflictDoUpdate({
      target: builtInModelKeys.vendor,
      set: {
        apiKey: input.apiKey,
        label: input.label,
        revision: sql`CASE
          WHEN ${builtInModelKeys.apiKey} IS DISTINCT FROM excluded.api_key
          THEN ${builtInModelKeys.revision} + 1
          ELSE ${builtInModelKeys.revision}
        END`,
        updatedAt: nowDate(),
      },
    })
    .returning({
      id: builtInModelKeys.id,
      vendor: builtInModelKeys.vendor,
      revision: builtInModelKeys.revision,
    });
  if (!row) {
    throw new Error(`Expected managed model key for vendor: ${input.vendor}`);
  }
  return row;
}
