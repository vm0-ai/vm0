import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../src/lib/test-endpoints/guard";

export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }
  const ts = `${Math.floor(Date.now() / 1000)}.000100`;
  return NextResponse.json({
    ok: true,
    channel: "C_E2E_MOCK",
    ts,
    message: { ts, text: "mocked" },
  });
}
