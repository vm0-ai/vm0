import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { voiceChatPreparations } from "../../../../../../src/db/schema/voice-chat";
import { updatePreparationStatus } from "../../../../../../src/lib/zero/voice-chat/preparation-service";
import { logger } from "../../../../../../src/lib/shared/logger";

const bodySchema = z.object({
  content: z.string().min(1),
});

const log = logger("api:zero:voice-chat:prepare:complete");

/**
 * POST /api/zero/voice-chat/prepare/complete
 *
 * Called from the sandbox CLI (`zero voice-chat context prepare --content "..."`)
 * to write preparation output. Auth via ZERO_TOKEN provides the runId,
 * which maps to the in-flight preparation.
 */
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

  // The sandbox ZERO_TOKEN provides a runId — use it to find the preparation
  const { runId } = authCtx;
  if (!runId) {
    return NextResponse.json(
      {
        error: {
          message: "Missing run context (requires sandbox token)",
          code: "UNAUTHORIZED",
        },
      },
      { status: 401 },
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

  const db = globalThis.services.db;

  // Find the in-flight preparation associated with this run
  const [preparation] = await db
    .select({ id: voiceChatPreparations.id })
    .from(voiceChatPreparations)
    .where(
      and(
        eq(voiceChatPreparations.runId, runId),
        eq(voiceChatPreparations.status, "preparing"),
      ),
    )
    .limit(1);

  if (!preparation) {
    return NextResponse.json(
      {
        error: {
          message: "No in-flight preparation found for this run",
          code: "NOT_FOUND",
        },
      },
      { status: 404 },
    );
  }

  const updated = await updatePreparationStatus(
    preparation.id,
    "ready",
    content,
  );

  log.info("Preparation completed", { preparationId: preparation.id });

  return NextResponse.json({
    id: updated!.id,
    status: updated!.status,
  });
}
