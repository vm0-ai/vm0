import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../src/lib/auth/test-endpoint-guard";
import { SLACK_E2E_FIXTURES } from "../../../../../src/lib/test-endpoints/slack-mock-fixtures";
import { logSlackMockCall } from "../../../../../src/lib/test-endpoints/slack-mock-logger";

export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }
  await logSlackMockCall("chat.postMessage", request);
  const ts = `${Math.floor(Date.now() / 1000)}.000100`;
  return NextResponse.json({
    ok: true,
    channel: SLACK_E2E_FIXTURES.channelId,
    ts,
    message: { ts, text: "mocked" },
  });
}
