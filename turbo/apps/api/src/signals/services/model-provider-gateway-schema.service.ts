import { sql } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import type { Db, ReadonlyDb } from "../external/db";

export async function modelProviderGatewaySchemaAvailable(
  db: Db | ReadonlyDb,
): Promise<boolean> {
  // This probe keeps the current API safe when it deploys before migration
  // 0741. Remove it after 0741 is guaranteed everywhere and rollback closes.
  const [state] = await db
    .select({
      available: sql`
        to_regclass('public.model_provider_connections') IS NOT NULL
        AND to_regclass('public.model_provider_surfaces') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'org_model_policies'
            AND column_name = 'model_provider_surface_id'
        )
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}
