import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { downgradeStalePaymentFailedSubscriptions } from "../../../../src/lib/zero/billing/billing-service";
import { logger } from "../../../../src/lib/shared/logger";
import { env } from "../../../../src/env";

const log = logger("cron:reconcile-billing-entitlements");

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

  const result = await downgradeStalePaymentFailedSubscriptions();

  if (result.downgraded > 0) {
    log.info("Billing entitlement reconciliation completed", result);
  }

  return NextResponse.json({ success: true, ...result });
}
