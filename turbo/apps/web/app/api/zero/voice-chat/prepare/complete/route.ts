import { NextResponse, after } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { voiceChatPreparations } from "../../../../../../src/db/schema/voice-chat";
import { logger } from "../../../../../../src/lib/shared/logger";
import { publishUserSignal } from "../../../../../../src/lib/infra/realtime/client";

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

  // Find, validate, and update preparation in a single transaction
  const result = await globalThis.services.db.transaction(async (tx) => {
    const [preparation] = await tx
      .select({
        id: voiceChatPreparations.id,
        status: voiceChatPreparations.status,
        orgId: voiceChatPreparations.orgId,
        userId: voiceChatPreparations.userId,
      })
      .from(voiceChatPreparations)
      .where(eq(voiceChatPreparations.runId, runId))
      .limit(1)
      .for("update");

    if (!preparation) {
      return { error: "NOT_FOUND" } as const;
    }

    if (authCtx.orgId && preparation.orgId !== authCtx.orgId) {
      return { error: "FORBIDDEN" } as const;
    }

    if (preparation.status !== "preparing") {
      return { error: "BAD_STATUS" } as const;
    }

    const [updated] = await tx
      .update(voiceChatPreparations)
      .set({ status: "ready", directiveContent: content })
      .where(eq(voiceChatPreparations.id, preparation.id))
      .returning({
        id: voiceChatPreparations.id,
        status: voiceChatPreparations.status,
      });

    if (!updated) {
      return { error: "UPDATE_FAILED" } as const;
    }

    return { updated, userId: preparation.userId } as const;
  });

  if ("error" in result) {
    switch (result.error) {
      case "NOT_FOUND":
        return NextResponse.json(
          {
            error: {
              message: "No preparation found for this run",
              code: "NOT_FOUND",
            },
          },
          { status: 404 },
        );
      case "FORBIDDEN":
        return NextResponse.json(
          {
            error: {
              message: "Preparation does not belong to this organization",
              code: "FORBIDDEN",
            },
          },
          { status: 403 },
        );
      case "BAD_STATUS":
        return NextResponse.json(
          {
            error: {
              message: "Preparation is not in preparing status",
              code: "BAD_REQUEST",
            },
          },
          { status: 400 },
        );
      case "UPDATE_FAILED":
        return NextResponse.json(
          {
            error: {
              message: "Failed to update preparation",
              code: "INTERNAL_SERVER_ERROR",
            },
          },
          { status: 500 },
        );
    }
  }

  log.info("Preparation completed", {
    preparationId: result.updated.id,
    runId,
  });

  // Notify the user that their voice chat preparation is ready
  after(() => {
    return publishUserSignal([result.userId], `voice:prep:${result.userId}`);
  });

  return NextResponse.json({
    id: result.updated.id,
    status: result.updated.status,
  });
}
