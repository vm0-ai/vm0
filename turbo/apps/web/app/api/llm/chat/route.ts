import { NextRequest, NextResponse } from "next/server";
import { llmChatRequestSchema, type LlmChatRequest } from "@vm0/core";
import { chat, chatStream } from "../../../../src/lib/llm/llm-service";
import { logger } from "../../../../src/lib/logger";
import { flushLogs } from "../../../../src/lib/logger";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { env } from "../../../../src/env";

const log = logger("api:llm:chat");

/**
 * POST /api/llm/chat - Send a chat completion request to OpenRouter
 *
 * Authentication:
 *   - If logged in: Uses OPENROUTER_API_KEY from environment
 *   - If not logged in: Requires x-openrouter-token header
 *
 * Body:
 *   model: string
 *   messages: Array<{ role: "user" | "assistant" | "system", content: string }>
 *   stream?: boolean (default: false)
 *
 * Response (non-streaming):
 *   { content: string, model: string, usage: TokenUsage }
 *
 * Response (streaming):
 *   SSE stream of { content: string } chunks, ending with [DONE]
 */
export async function POST(request: NextRequest) {
  initServices();

  // Determine token: logged-in users use env token, others need header
  const userId = await getUserId(
    request.headers.get("authorization") ?? undefined,
  );
  let token: string;

  if (userId) {
    // User is logged in - use environment token
    const envToken = env().OPENROUTER_API_KEY;
    if (!envToken) {
      await flushLogs();
      return NextResponse.json(
        {
          error: {
            message: "OpenRouter API key not configured",
            code: "SERVICE_UNAVAILABLE",
          },
        },
        { status: 503 },
      );
    }
    token = envToken;
    log.debug("using environment token for logged-in user", { userId });
  } else {
    // Not logged in - require header token
    const headerToken = request.headers.get("x-openrouter-token");
    if (!headerToken) {
      await flushLogs();
      return NextResponse.json(
        {
          error: {
            message:
              "Authentication required. Either log in or provide x-openrouter-token header.",
            code: "UNAUTHORIZED",
          },
        },
        { status: 401 },
      );
    }
    token = headerToken;
  }

  const rawBody: unknown = await request.json();
  const parseResult = llmChatRequestSchema.safeParse(rawBody);

  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    await flushLogs();
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

  const body: LlmChatRequest = parseResult.data;
  const { model, messages, stream } = body;

  log.debug("chat request received", {
    model,
    stream,
    messageCount: messages.length,
  });

  if (stream) {
    // Streaming response using SSE
    // Note: try-catch is necessary here because HTTP status is already sent
    // and we can only communicate errors via SSE messages
    const streamResponse = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for await (const chunk of chatStream(token, { model, messages })) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ content: chunk })}\n\n`),
            );
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          log.error("streaming error", { error });
          const errorCode =
            error instanceof Error && "code" in error
              ? String(error.code)
              : "STREAM_ERROR";
          const message =
            error instanceof Error ? error.message : "Unknown error";
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: { message, code: errorCode } })}\n\n`,
            ),
          );
          controller.close();
        } finally {
          await flushLogs();
        }
      },
    });

    return new Response(streamResponse, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // Non-streaming response
  const result = await chat(token, { model, messages });

  await flushLogs();
  return NextResponse.json({
    content: result.content,
    model: result.model,
    usage: result.usage,
  });
}
