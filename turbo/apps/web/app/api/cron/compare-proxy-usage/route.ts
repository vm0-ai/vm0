import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { compareRecentRunsProxyUsage } from "../../../../src/lib/zero/credit/proxy-usage-comparison-service";
import { logger } from "../../../../src/lib/shared/logger";
import { env } from "../../../../src/env";

const log = logger("cron:compare-proxy-usage");

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

  try {
    await compareRecentRunsProxyUsage();
  } catch (err) {
    log.error("Proxy usage comparison failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({ success: true });
}
