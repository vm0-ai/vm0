import { createServer, type ServerResponse } from "node:http";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  inspectPiSessionJsonl,
  runPiApiFirstTurn,
  UnsupportedPiSessionVersionError,
} from "./api";
import { projectPiApiAssistantMessage } from "./api-turn";
import { MemoryPiSession } from "./session-memory";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";

function responsesTextSse(response: ServerResponse, text: string): void {
  const responseId = "resp_terra_api_first";
  const messageId = "msg_terra_api_first";
  const events = [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: messageId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    events
      .map((event) => {
        return `data: ${JSON.stringify(event)}\n\n`;
      })
      .join(""),
  );
}

describe("Pi API facade", () => {
  it("uses Terra Responses with low thinking for an API-first turn", async () => {
    let providerRequest:
      | { readonly url: string | undefined; readonly body: unknown }
      | undefined;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        providerRequest = {
          url: request.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        };
        responsesTextSse(response, "Terra API-first answer");
      })().catch((error: unknown) => {
        response.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Terra API-first test server has no TCP address");
    }

    try {
      const result = await runPiApiFirstTurn({
        cwd: "/home/user/workspace",
        agentDir: "/home/user/.pi/agent",
        sessionId: SESSION_ID,
        prompt: "answer through Terra",
        appendSystemPrompt: null,
        model: {
          provider: "openai",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test-key",
          model: "gpt-5.6-terra",
          api: "openai-responses",
          thinkingLevel: "low",
        },
        resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
      });

      expect(providerRequest).toMatchObject({
        url: "/v1/responses",
        body: {
          model: "gpt-5.6-terra",
          reasoning: { effort: "low" },
        },
      });
      expect(result.assistantMessage.content).toStrictEqual([
        { type: "text", text: "Terra API-first answer" },
      ]);
      expect(
        MemoryPiSession.fromJsonl(result.sessionJsonl).buildSessionContext()
          .thinkingLevel,
      ).toBe("low");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it("projects only API-consumed assistant fields", () => {
    const nativeMessage: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "before tools" },
        { type: "thinking", thinking: "private reasoning" },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "/workspace/AGENTS.md" },
        },
      ],
      api: "openai-responses",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      responseId: "response-1",
      errorMessage: "native-only diagnostic",
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
        reasoning: 5,
        totalTokens: 18,
        cost: {
          input: 0.1,
          output: 0.2,
          cacheRead: 0.03,
          cacheWrite: 0.02,
          total: 0.35,
        },
      },
      stopReason: "toolUse",
      timestamp: 123,
    };

    expect(projectPiApiAssistantMessage(nativeMessage)).toStrictEqual({
      content: [
        { type: "text", text: "before tools" },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "/workspace/AGENTS.md" },
        },
      ],
      model: "deepseek-v4-flash",
      responseId: "response-1",
      stopReason: "toolUse",
      timestamp: 123,
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
      },
    });
  });

  it("projects native session state into a narrow inspection result", () => {
    const session = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "complete" }],
      api: "openai-responses",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 1,
    });

    expect(inspectPiSessionJsonl(session.toJsonl())).toStrictEqual({
      sessionId: SESSION_ID,
      messageCount: 1,
      hasPendingToolCalls: false,
      isSettledCheckpoint: true,
    });
  });

  it("preserves the clean entrypoint's unsupported-version error identity", () => {
    const jsonl = `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION + 1,
      id: SESSION_ID,
      timestamp: new Date(0).toISOString(),
      cwd: "/home/user/workspace",
    })}\n`;

    expect(() => {
      inspectPiSessionJsonl(jsonl);
    }).toThrow(UnsupportedPiSessionVersionError);
  });
});
