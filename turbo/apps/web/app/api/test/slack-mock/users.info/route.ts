import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../src/lib/auth/test-endpoint-guard";
import { SLACK_E2E_FIXTURES } from "../../../../../src/lib/test-endpoints/slack-mock-fixtures";

async function readUserId(request: Request): Promise<string> {
  const ctype = request.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    const body = (await request.json().catch(() => {
      return {};
    })) as { user?: string };
    if (body.user) return body.user;
  } else {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const user = params.get("user");
    if (user) return user;
  }
  return SLACK_E2E_FIXTURES.userUserId;
}

export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }
  const userId = await readUserId(request);
  return NextResponse.json({
    ok: true,
    user: {
      id: userId,
      name: "e2e-user",
      real_name: "E2E User",
      tz: "UTC",
      tz_label: "Coordinated Universal Time",
      profile: {
        display_name: "e2e-user",
        real_name: "E2E User",
        email: "e2e@example.com",
      },
    },
  });
}
