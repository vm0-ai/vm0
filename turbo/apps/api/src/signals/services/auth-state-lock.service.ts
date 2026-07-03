import { sql } from "drizzle-orm";

import type { Db } from "../external/db";

export async function lockConnectorState(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: string;
  },
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('connector_state:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.type}))`,
  );
}

export async function lockModelProviderState(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: string;
  },
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('model_provider_state:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.type}))`,
  );
}
