import { sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

export async function lockPresentationTemplateLifecycle(
  db: Tx,
  templateId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`presentation_template:${templateId}`}, 0))`,
  );
}
