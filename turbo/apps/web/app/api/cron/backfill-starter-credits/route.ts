import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("cron:backfill-starter-credits");

const STARTER_CREDITS = 10_000;

/**
 * One-off backfill: grant 10 000 starter credits to free-tier orgs
 * whose balance is zero. These are legacy orgs created before migration
 * 0180 changed the column DEFAULT from 0 to 10 000.
 *
 * Idempotent — only touches rows where credits = 0 AND tier = 'free'.
 * Safe to re-run: orgs that already received credits are skipped.
 */
export async function POST(request: Request): Promise<Response> {
  initServices();

  const authHeader = request.headers.get("authorization");
  const cronSecret = env().CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const db = globalThis.services.db;

  const result = await db.execute(sql`
    UPDATE org_metadata
    SET credits = credits + ${STARTER_CREDITS},
        updated_at = now()
    WHERE tier = 'free'
      AND credits = 0
  `);

  const updated = result.rowCount ?? 0;

  log.info("Backfill starter credits completed", { updated });

  return NextResponse.json({ success: true, updated });
}
