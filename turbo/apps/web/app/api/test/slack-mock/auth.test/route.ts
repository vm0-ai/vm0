import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../src/lib/test-endpoints/guard";

export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    url: "https://e2e-mock.invalid/",
    team: "E2E Test Team",
    user: "e2e-bot",
    team_id: "T_E2E",
    user_id: "U_E2E_BOT",
    bot_id: "B_E2E_BOT",
  });
}
