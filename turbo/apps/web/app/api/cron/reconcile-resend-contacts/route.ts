import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { reconcileContacts } from "../../../../src/lib/zero/email/contact-reconcile-service";
import { logger } from "../../../../src/lib/shared/logger";
import { env } from "../../../../src/env";

const log = logger("cron:reconcile-resend-contacts");

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

  if (!env().RESEND_CONTACT_SEGMENT_ID) {
    return NextResponse.json({
      success: true,
      skipped: true,
      clerkUsersScanned: 0,
      created: 0,
      updated: 0,
      deleted: 0,
    });
  }

  const stats = await reconcileContacts();

  log.debug("Resend contact reconcile completed", stats);

  return NextResponse.json({ success: true, ...stats });
}
