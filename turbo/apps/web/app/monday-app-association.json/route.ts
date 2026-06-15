import { NextResponse } from "next/server";
import { env } from "../../src/env";

export async function GET() {
  const envVars = env();

  if (!envVars.MONDAY_OAUTH_CLIENT_ID || !envVars.MONDAY_OAUTH_APP_ID) {
    return NextResponse.json(
      { error: "Monday.com OAuth not configured" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    client_id: envVars.MONDAY_OAUTH_CLIENT_ID,
    app_id: envVars.MONDAY_OAUTH_APP_ID,
  });
}
