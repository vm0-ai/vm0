import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../src/lib/auth/test-endpoint-guard";
import { SLACK_E2E_FIXTURES } from "../../../../../src/lib/test-endpoints/slack-mock-fixtures";

export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    url: "https://e2e-mock.invalid/",
    team: SLACK_E2E_FIXTURES.teamName,
    user: "e2e-bot",
    team_id: SLACK_E2E_FIXTURES.teamId,
    user_id: SLACK_E2E_FIXTURES.botUserId,
    bot_id: SLACK_E2E_FIXTURES.botId,
  });
}
