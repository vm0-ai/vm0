import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../src/lib/test-endpoints/guard";
import { SLACK_E2E_FIXTURES } from "../../../../../src/lib/test-endpoints/slack-mock-fixtures";

export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }
  const ts = `${Math.floor(Date.now() / 1000)}.000100`;
  return NextResponse.json({
    ok: true,
    channel: SLACK_E2E_FIXTURES.channelId,
    ts,
    message: { ts, text: "mocked" },
  });
}
