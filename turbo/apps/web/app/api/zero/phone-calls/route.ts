import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import {
  createOutboundCall,
  listPhoneCalls,
} from "../../../../src/lib/zero/phone/phone-calls-service";

const createCallSchema = z.object({
  toNumber: z.string().regex(/^\+[1-9]\d{1,14}$/, "Use E.164 format"),
  greeting: z.string().optional(),
  systemPrompt: z.string().optional(),
});

/**
 * POST /api/zero/phone-calls — create an outbound phone call.
 * Auth: ZERO_TOKEN (sandbox) or Clerk JWT (web UI).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
    { acceptAnySandboxCapability: true },
  );
  if (!authCtx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { org } = await resolveOrg(authCtx);

  const parsed = createCallSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const { toNumber, greeting, systemPrompt } = parsed.data;

  const result = await createOutboundCall(org.orgId, toNumber, {
    greeting,
    systemPrompt,
  });
  return NextResponse.json(result, { status: 201 });
}

/**
 * GET /api/zero/phone-calls — list recent calls for the org.
 * Auth: ZERO_TOKEN (sandbox) or Clerk JWT (web UI).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
    { acceptAnySandboxCapability: true },
  );
  if (!authCtx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { org } = await resolveOrg(authCtx);

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit")) || 20;
  const offset = Number(url.searchParams.get("offset")) || 0;

  const result = await listPhoneCalls(org.orgId, { limit, offset });
  return NextResponse.json(result);
}
