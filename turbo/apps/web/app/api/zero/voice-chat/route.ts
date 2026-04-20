import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { isFeatureEnabled, FeatureSwitchKey } from "@vm0/core";
import {
  createSession,
  dispatchSlowBrain,
  dispatchObservationSlowBrain,
  writeCachedPreparationEvents,
} from "../../../../src/lib/zero/voice-chat/session-service";
import { findFreshPreparation } from "../../../../src/lib/zero/voice-chat/preparation-service";
import { isApiError } from "../../../../src/lib/shared/errors";
import { logger } from "../../../../src/lib/shared/logger";
import { loadFeatureSwitchOverrides } from "../../../../src/lib/zero/user/feature-switches-service";

const bodySchema = z
  .object({
    agentId: z.string().min(1),
    mode: z.enum(["chat", "meeting"]).default("chat"),
    prompt: z.string().min(1).optional(),
  })
  .refine(
    (data) => {
      return data.mode !== "meeting" || data.prompt;
    },
    {
      message: "prompt is required for meeting mode",
      path: ["prompt"],
    },
  );

const log = logger("api:zero:voice-chat");

export async function POST(request: Request) {
  const apiStartTime = Date.now();
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

  const overrides = await loadFeatureSwitchOverrides(org.orgId, userId);
  const enabled = isFeatureEnabled(FeatureSwitchKey.VoiceChat, {
    orgId: org.orgId,
    userId,
    overrides,
  });
  if (!enabled) {
    return NextResponse.json(
      { error: { message: "Voice chat is not enabled", code: "FORBIDDEN" } },
      { status: 403 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      {
        error: {
          message: issue?.message ?? "Invalid request body",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }
  const { agentId, mode, prompt } = parsed.data;

  try {
    const session = await createSession(org.orgId, userId, agentId, {
      mode,
      prompt,
    });

    const preparation = await findFreshPreparation(
      org.orgId,
      userId,
      agentId,
      mode,
      prompt,
    );

    if (preparation) {
      await writeCachedPreparationEvents(
        session.id,
        preparation.directiveContent,
      );
      const run = await dispatchObservationSlowBrain(
        {
          ...session,
          agentId,
        },
        apiStartTime,
      );

      return NextResponse.json({
        session: {
          id: session.id,
          mode: session.mode,
          status: session.status,
          runId: run.runId,
          createdAt: session.createdAt,
          prepared: true,
        },
      });
    }

    const run = await dispatchSlowBrain(
      session,
      org.orgId,
      userId,
      agentId,
      apiStartTime,
      {
        mode,
        prompt,
      },
    );

    return NextResponse.json({
      session: {
        id: session.id,
        mode: session.mode,
        status: session.status,
        runId: run.runId,
        createdAt: session.createdAt,
        prepared: false,
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
