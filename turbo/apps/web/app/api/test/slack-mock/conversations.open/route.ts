import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../src/lib/auth/test-endpoint-guard";

export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    channel: { id: "D_E2E_MOCK" },
  });
}
