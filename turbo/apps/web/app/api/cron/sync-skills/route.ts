import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { syncSkills } from "../../../../src/lib/zero/skills/sync-skills";
import { logger } from "../../../../src/lib/shared/logger";
import { env } from "../../../../src/env";

const log = logger("cron:sync-skills");

export async function GET(request: Request): Promise<Response> {
  initServices();

  const authHeader = request.headers.get("authorization");
  const cronSecret = env().CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const result = await syncSkills();

  if (result.synced > 0) {
    log.info("Skills sync completed", result);
  }

  return NextResponse.json({ success: true, ...result });
}
