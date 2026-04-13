import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { voiceChatPreparations } from "../../../../../../src/db/schema/voice-chat";
import { updatePreparationStatus } from "../../../../../../src/lib/zero/voice-chat/preparation-service";
import { logger } from "../../../../../../src/lib/shared/logger";

const bodySchema = z.object({
  content: z.string().min(1),
});

const log = logger("api:zero:voice-chat:prepare:complete");

export async function POST(request: Request) {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
    { acceptAnySandboxCapability: true },
  );
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { runId } = authCtx;
  if (!runId) {
    return NextResponse.json(
      {
        error: {
          message: "This endpoint must be called from a sandbox run",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
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
  const { content } = parsed.data;

  // Find the preparation associated with this run
  const [preparation] = await globalThis.services.db
    .select({
      id: voiceChatPreparations.id,
      status: voiceChatPreparations.status,
    })
    .from(voiceChatPreparations)
    .where(eq(voiceChatPreparations.runId, runId))
    .limit(1);

  if (!preparation) {
    return NextResponse.json(
      {
        error: {
          message: "No preparation found for this run",
          code: "NOT_FOUND",
        },
      },
      { status: 404 },
    );
  }

  if (preparation.status !== "preparing") {
    return NextResponse.json(
      {
        error: {
          message: "Preparation is not in preparing status",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  const updated = await updatePreparationStatus(
    preparation.id,
    "ready",
    content,
  );

  log.info("Preparation completed", { preparationId: preparation.id, runId });

  return NextResponse.json({
    id: updated!.id,
    status: updated!.status,
  });
}
