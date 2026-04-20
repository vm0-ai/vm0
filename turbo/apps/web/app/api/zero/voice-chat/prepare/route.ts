import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { isFeatureEnabled, FeatureSwitchKey } from "@vm0/core";
import {
  findFreshPreparation,
  findInFlightPreparation,
  createPreparation,
  dispatchPreparationRun,
} from "../../../../../src/lib/zero/voice-chat/preparation-service";
import { isApiError } from "../../../../../src/lib/shared/errors";
import { logger } from "../../../../../src/lib/shared/logger";
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";

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

const log = logger("api:zero:voice-chat:prepare");

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

  // Check for a fresh cached preparation (cache hit)
  const fresh = await findFreshPreparation(
    org.orgId,
    userId,
    agentId,
    mode,
    prompt,
  );
  if (fresh) {
    return NextResponse.json({
      preparation: { id: fresh.id, status: "ready" },
    });
  }

  // Check for an in-flight preparation (dedup)
  const inflight = await findInFlightPreparation(
    org.orgId,
    userId,
    agentId,
    mode,
  );
  if (inflight) {
    return NextResponse.json({
      preparation: { id: inflight.id, status: "preparing" },
    });
  }

  // Create a new preparation and dispatch the run
  try {
    const preparation = await createPreparation(
      org.orgId,
      userId,
      agentId,
      mode,
      prompt,
    );
    const run = await dispatchPreparationRun(preparation.id, userId, agentId, {
      mode,
      prompt,
      apiStartTime,
    });

    return NextResponse.json({
      preparation: {
        id: preparation.id,
        status: preparation.status,
        runId: run.runId,
      },
    });
  } catch (error) {
    if (isApiError(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: error.code } },
        { status: error.statusCode },
      );
    }
    log.error("Failed to create voice-chat preparation", error);
    throw error;
  }
}
