import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import {
  createOutboundCall,
  listPhoneCalls,
} from "../../../../src/lib/zero/phone/phone-calls-service";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("api:phone-calls");

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

  try {
    const result = await createOutboundCall(org.orgId, toNumber, {
      greeting,
      systemPrompt,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    log.error("Failed to create outbound call", {
      orgId: org.orgId,
      error: err,
    });
    const message =
      err instanceof Error ? err.message : "Failed to create call";
    return NextResponse.json({ error: message }, { status: 400 });
  }
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

  try {
    const result = await listPhoneCalls(org.orgId, { limit, offset });
    return NextResponse.json(result);
  } catch (err) {
    log.error("Failed to list phone calls", { orgId: org.orgId, error: err });
    return NextResponse.json(
      { error: "Failed to list calls" },
      { status: 500 },
    );
  }
}
