import { sql } from "drizzle-orm";

import { db } from "../../lib/db";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { singleton } from "../../lib/singleton";
import type { Db } from "../external/db";

type ReadDb = Pick<Db, "select">;

interface SchemaReadinessState {
  ready: boolean;
}

const schemaReadinessState = singleton<SchemaReadinessState>(() => {
  return { ready: false };
});

async function probePublicBrandSchemaReady(readDb: ReadDb): Promise<boolean> {
  const [state] = await readDb
    .select({
      ready: sql`
        NOT EXISTS (
          SELECT 1
          FROM (
            VALUES
              ('agentphone_user_links'),
              ('email_outbox'),
              ('export_jobs'),
              ('feishu_org_installations'),
              ('morning_brief_deliveries'),
              ('morning_brief_schedules'),
              ('push_subscriptions'),
              ('shared_threads'),
              ('slack_org_installations'),
              ('teams_org_installations'),
              ('telegram_installations'),
              ('telegram_official_user_links')
          ) AS required(table_name)
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_attribute
            WHERE attrelid = to_regclass('public.' || required.table_name)
              AND attname = 'public_brand'
              AND NOT attisdropped
          )
        )
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.ready ?? false;
}

export async function publicBrandSchemaReady(): Promise<boolean> {
  const state = schemaReadinessState();
  if (state.ready) {
    return true;
  }
  // On the DB/API surface, new API instances can appear before migrations 0934
  // and 0935 are visible (observed maximum exposure is about 102 minutes).
  // Refuse traffic instead of issuing column-dependent queries, then remove
  // this gate once both migrations are guaranteed across the production
  // rollback window (tracked by #27660).
  state.ready = await probePublicBrandSchemaReady(db());
  return state.ready;
}
