import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { orgMetadata } from "../../../../src/db/schema/org-metadata";
import {
  createOutboundCall,
  listPhoneCalls,
} from "../../../../src/lib/zero/phone/phone-calls-service";
import {
  registerPendingOutboundCall,
  lookupPhoneThreadSession,
} from "../../../../src/lib/zero/phone/handlers/shared";

const createCallSchema = z.object({
  toNumber: z.string().regex(/^\+[1-9]\d{1,14}$/, "Use E.164 format"),
  greeting: z.string().optional(),
  systemPrompt: z.string().optional(),
  mode: z.enum(["onhold", "fire-and-forget"]).optional(),
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

  const { toNumber, greeting, systemPrompt, mode } = parsed.data;

  // For fire-and-forget calls, validate the default agent BEFORE placing the call
  // so we never dial a number and then return a validation error.
  let defaultAgentId: string | undefined;
  if (mode === "fire-and-forget") {
    const [meta] = await globalThis.services.db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, org.orgId))
      .limit(1);

    if (!meta?.defaultAgentId) {
      return NextResponse.json(
        {
          error:
            "fire-and-forget mode requires a default agent to be configured for the org",
        },
        { status: 422 },
      );
    }

    defaultAgentId = meta.defaultAgentId;
  }

  const result = await createOutboundCall(org.orgId, toNumber, {
    greeting,
    systemPrompt,
  });

  // Register the call so the call_ended webhook can trigger a follow-up run
  // with the transcript once the conversation completes.
  if (mode === "fire-and-forget" && defaultAgentId) {
    const existingSession = await lookupPhoneThreadSession(
      authCtx.userId,
      org.orgId,
    );
    await registerPendingOutboundCall({
      callId: result.callId,
      orgId: org.orgId,
      userId: authCtx.userId,
      agentId: defaultAgentId,
      sessionId: existingSession?.agentSessionId,
    });
  }

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
