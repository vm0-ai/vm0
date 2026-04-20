import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../src/lib/auth/test-endpoint-guard";
import {
  SLACK_E2E_FIXTURES,
  SLACK_E2E_SCOPES,
} from "../../../../../src/lib/test-endpoints/slack-mock-fixtures";

export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    access_token: SLACK_E2E_FIXTURES.botToken,
    token_type: "bot",
    scope: SLACK_E2E_SCOPES.join(","),
    bot_user_id: SLACK_E2E_FIXTURES.botUserId,
    app_id: SLACK_E2E_FIXTURES.appId,
    team: {
      id: SLACK_E2E_FIXTURES.teamId,
      name: SLACK_E2E_FIXTURES.teamName,
    },
    enterprise: null,
    authed_user: {
      id: SLACK_E2E_FIXTURES.userUserId,
      scope: "",
      access_token: "",
      token_type: "user",
    },
  });
}
