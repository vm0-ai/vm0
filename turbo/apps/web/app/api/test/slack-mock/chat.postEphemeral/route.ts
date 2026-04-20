import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../src/lib/auth/test-endpoint-guard";
import { logSlackMockCall } from "../../../../../src/lib/test-endpoints/slack-mock-logger";

export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }
  await logSlackMockCall("chat.postEphemeral", request);
  return NextResponse.json({
    ok: true,
    message_ts: `${Math.floor(Date.now() / 1000)}.000200`,
  });
}
