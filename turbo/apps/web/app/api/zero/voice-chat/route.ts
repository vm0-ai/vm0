import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { isFeatureEnabled, FeatureSwitchKey } from "@vm0/core";
import {
  createSession,
  dispatchSlowBrain,
} from "../../../../src/lib/zero/voice-chat/session-service";
import { isApiError } from "../../../../src/lib/shared/errors";
import { logger } from "../../../../src/lib/shared/logger";

const bodySchema = z.object({
  agentId: z.string().min(1),
});

const log = logger("api:zero:voice-chat");

export async function POST(request: Request) {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx?.orgId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { org } = await resolveOrg(authCtx);
  const { userId } = authCtx;

  const enabled = isFeatureEnabled(FeatureSwitchKey.VoiceChat, {
    orgId: org.orgId,
    userId,
  });
  if (!enabled) {
    return NextResponse.json(
      { error: { message: "Voice chat is not enabled", code: "FORBIDDEN" } },
      { status: 403 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: { message: "agentId is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }
  const { agentId } = parsed.data;

  try {
    const session = await createSession(org.orgId, userId, agentId);
    const run = await dispatchSlowBrain(session, org.orgId, userId, agentId);

    return NextResponse.json({
      session: {
        id: session.id,
        status: session.status,
        runId: run.runId,
        createdAt: session.createdAt,
      },
    });
  } catch (error) {
    if (isApiError(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: error.code } },
        { status: error.statusCode },
      );
    }
    log.error("Failed to create voice-chat session", error);
    throw error;
  }
}
