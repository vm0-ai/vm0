import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../src/lib/test-endpoints/guard";

const SCOPES = [
  "app_mentions:read",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "commands",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
  "users:read.email",
].join(",");

export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    access_token: "xoxb-e2e-test-bot-token",
    token_type: "bot",
    scope: SCOPES,
    bot_user_id: "U_E2E_BOT",
    app_id: "A_E2E_APP",
    team: { id: "T_E2E", name: "E2E Test Team" },
    enterprise: null,
    authed_user: {
      id: "U_E2E_USER",
      scope: "",
      access_token: "",
      token_type: "user",
    },
  });
}
