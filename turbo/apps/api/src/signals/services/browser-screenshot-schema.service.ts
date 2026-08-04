import { sql } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import type { Db, ReadonlyDb } from "../external/db";

export async function browserScreenshotSchemaAvailable(
  db: Db | ReadonlyDb,
): Promise<boolean> {
  // This probe keeps the current API safe when it deploys before migration
  // 0809. Remove it after 0809 is guaranteed everywhere and rollback closes.
  const [state] = await db
    .select({
      available: sql`
        to_regclass('public.browser_session_screenshots') IS NOT NULL
        AND to_regclass('public.browser_session_screenshot_deletions') IS NOT NULL
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}
