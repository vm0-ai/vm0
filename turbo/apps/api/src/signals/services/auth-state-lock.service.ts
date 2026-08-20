import { sql } from "drizzle-orm";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";

import type { Db } from "../external/db";

export async function lockConnectorState(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
  },
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('connector_state:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.connectorSlug}))`,
  );
}

export async function lockConnectorAccountTarget(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
  },
): Promise<void> {
  if (args.target.kind === "builtin") {
    await lockConnectorState(db, {
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: args.target.connectorSlug,
    });
    return;
  }
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('connector_state:' || ${args.orgId} || ':' || ${args.userId} || ':custom:' || ${args.target.customConnectorId}))`,
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
