import { NextResponse } from "next/server";
import { initServices } from "../../src/lib/init-services";

export async function GET() {
  initServices();
  const env = globalThis.services.env;

  if (!env.MONDAY_OAUTH_CLIENT_ID || !env.MONDAY_OAUTH_APP_ID) {
    return NextResponse.json(
      { error: "Monday.com OAuth not configured" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    client_id: env.MONDAY_OAUTH_CLIENT_ID,
    app_id: env.MONDAY_OAUTH_APP_ID,
  });
}
