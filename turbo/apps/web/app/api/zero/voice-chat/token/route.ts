import { NextResponse } from "next/server";
import { FeatureSwitchKey, isFeatureEnabled } from "@vm0/core";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../src/lib/init-services";
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";
import { env } from "../../../../../src/env";
import { createEphemeralToken } from "../../../../../src/lib/zero/voice-chat/openai-token";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:zero:voice-chat:token");

export async function POST(request: Request): Promise<Response> {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const overrides = await loadFeatureSwitchOverrides(
    authCtx.orgId,
    authCtx.userId,
  );
  const enabled = isFeatureEnabled(FeatureSwitchKey.VoiceChat, {
    orgId: authCtx.orgId,
    userId: authCtx.userId,
    overrides,
  });
  if (!enabled) {
    return NextResponse.json(
      { error: { message: "Voice chat is not enabled", code: "FORBIDDEN" } },
      { status: 403 },
    );
  }

  if (!env().OPENAI_API_KEY) {
    return NextResponse.json(
      {
        error: {
          message: "OpenAI API key not configured",
          code: "SERVICE_UNAVAILABLE",
        },
      },
      { status: 503 },
    );
  }

  try {
    const result = await createEphemeralToken();
    return NextResponse.json(result);
  } catch (error) {
    log.error("Failed to create ephemeral token", { error });
    return NextResponse.json(
      {
        error: {
          message: "Failed to create ephemeral token",
          code: "INTERNAL_SERVER_ERROR",
        },
      },
      { status: 500 },
    );
  }
}
