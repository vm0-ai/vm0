import { NextRequest, NextResponse } from "next/server";
import { llmChatRequestSchema, type LlmChatRequest } from "@vm0/core";
import { chat, chatStream } from "../../../../src/lib/llm/llm-service";
import { logger } from "../../../../src/lib/logger";
import { flushLogs } from "../../../../src/lib/logger";

const log = logger("api:llm:chat");

/**
 * POST /api/llm/chat - Send a chat completion request to OpenRouter
 *
 * Headers:
 *   x-openrouter-token: string (required)
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
  try {
    const token = request.headers.get("x-openrouter-token");
    if (!token) {
      await flushLogs();
      return NextResponse.json(
        {
          error: {
            message: "Missing x-openrouter-token header",
            code: "UNAUTHORIZED",
          },
        },
        { status: 401 },
      );
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
      const streamResponse = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          try {
            for await (const chunk of chatStream(token, { model, messages })) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ content: chunk })}\n\n`,
                ),
              );
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (error) {
            log.error("streaming error", { error });
            const message =
              error instanceof Error ? error.message : "Unknown error";
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`),
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
  } catch (error) {
    log.error("chat error", { error });

    const message =
      error instanceof Error ? error.message : "Unknown error occurred";

    await flushLogs();
    return NextResponse.json(
      { error: { message, code: "INTERNAL_SERVER_ERROR" } },
      { status: 500 },
    );
  }
}
