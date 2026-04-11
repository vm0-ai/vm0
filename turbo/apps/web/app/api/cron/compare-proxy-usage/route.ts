import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { compareRecentRunsProxyUsage } from "../../../../src/lib/zero/credit/proxy-usage-comparison-service";
import { env } from "../../../../src/env";

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

  await compareRecentRunsProxyUsage();

  return NextResponse.json({ success: true });
}
