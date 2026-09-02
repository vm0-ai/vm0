import { createServer, type ServerResponse } from "node:http";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  createPiApiFirstTurnOwnership,
  createPiSessionJsonl,
  inspectPiSessionJsonl,
  PiApiFirstTurnCompactionRequiredError,
  runPiApiFirstTurn,
  UnsupportedPiSessionVersionError,
} from "./api";
import { projectPiApiAssistantMessage } from "./api-turn";
import { resolvePiAgentModel } from "./model";
import { MemoryPiSession } from "./session-memory";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const SESSION_TIMESTAMP = "2026-08-31T12:34:56.000Z";

function responsesTextSse(
  response: ServerResponse,
  text: string,
  options?: {
    readonly fragmentTerminal?: boolean;
    readonly serviceTier?: string | null;
  },
): void {
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
        ...(options && "serviceTier" in options
          ? { service_tier: options.serviceTier }
          : {}),
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  const body = events
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
  if (!options?.fragmentTerminal) {
    response.end(body);
    return;
  }
  const splitAt = body.lastIndexOf("service_tier") + 5;
  response.write(body.slice(0, splitAt));
  setImmediate(() => {
    response.end(body.slice(splitAt));
  });
}

describe("Pi API facade", () => {
  it("keeps provider request ownership monotonic", () => {
    const ownership = createPiApiFirstTurnOwnership();

    expect(ownership.stage).toBe("pre-provider");
    ownership.markProviderRequestMayHaveStarted();
    expect(ownership.stage).toBe("provider-may-have-started");
    ownership.markProviderRequestMayHaveStarted();
    expect(ownership.stage).toBe("provider-may-have-started");
  });

  it("creates one canonical empty native Pi history", () => {
    const jsonl = createPiSessionJsonl({
      cwd: "/home/user/workspace",
      sessionId: SESSION_ID,
      timestamp: SESSION_TIMESTAMP,
    });

    expect(inspectPiSessionJsonl(jsonl)).toStrictEqual({
      sessionId: SESSION_ID,
      messageCount: 0,
      hasPendingToolCalls: false,
      isSettledCheckpoint: false,
    });
    expect(JSON.parse(jsonl.split("\n")[0] ?? "{}")).toMatchObject({
      id: SESSION_ID,
      timestamp: SESSION_TIMESTAMP,
    });
  });

  it("normalizes legacy transport input and applies Terra request policy", async () => {
    const providerRequests: Array<{
      readonly url: string | undefined;
      readonly body: unknown;
    }> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        providerRequests.push({
          url: request.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
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
      const runTurn = async (
        serviceTier: "priority" | undefined,
        api: "openai-completions" | "openai-codex-responses",
      ) => {
        return runPiApiFirstTurn({
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
            api,
            thinkingLevel: "low",
            ...(serviceTier ? { serviceTier } : {}),
          },
          resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
          ownership: createPiApiFirstTurnOwnership(),
        });
      };
      const standardResult = await runTurn(undefined, "openai-completions");
      const priorityResult = await runTurn(
        "priority",
        "openai-codex-responses",
      );

      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[0]).toMatchObject({
        url: "/v1/responses",
        body: {
          model: "gpt-5.6-terra",
          reasoning: { effort: "low" },
        },
      });
      expect(providerRequests[0]?.body).not.toHaveProperty("service_tier");
      expect(providerRequests[1]).toMatchObject({
        url: "/v1/responses",
        body: {
          model: "gpt-5.6-terra",
          reasoning: { effort: "low" },
          service_tier: "priority",
        },
      });
      expect(standardResult.assistantMessage.content).toStrictEqual([
        { type: "text", text: "Terra API-first answer" },
      ]);
      expect(priorityResult.assistantMessage.content).toStrictEqual([
        { type: "text", text: "Terra API-first answer" },
      ]);
      expect(standardResult.observedServiceTier).toBeUndefined();
      expect(priorityResult.observedServiceTier).toBeUndefined();
      expect(priorityResult.sessionJsonl).not.toContain("serviceTier");
      expect(priorityResult.sessionJsonl).not.toContain("service_tier");
      expect(
        MemoryPiSession.fromJsonl(
          priorityResult.sessionJsonl,
        ).buildSessionContext().thinkingLevel,
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

  it("captures fragmented terminal OpenRouter tiers without persisting them", async () => {
    const observedTiers = [
      "priority",
      "fast",
      "default",
      "flex",
      null,
      undefined,
      "future-tier",
    ] as const;
    const requestBodies: unknown[] = [];
    let responseIndex = 0;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        requestBodies.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        );
        const serviceTier = observedTiers[responseIndex];
        responseIndex += 1;
        responsesTextSse(response, "OpenRouter answer", {
          fragmentTerminal: true,
          ...(serviceTier === undefined ? {} : { serviceTier }),
        });
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
      throw new Error("OpenRouter tier test server has no TCP address");
    }

    try {
      const results = [];
      for (const _serviceTier of observedTiers) {
        results.push(
          await runPiApiFirstTurn({
            cwd: "/home/user/workspace",
            agentDir: "/home/user/.pi/agent",
            sessionId: SESSION_ID,
            prompt: "observe the terminal tier",
            appendSystemPrompt: null,
            model: {
              provider: "openrouter",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "test-key",
              model: "openai/gpt-5.6-terra",
              api: "openai-responses",
              thinkingLevel: "low",
              serviceTier: "priority",
            },
            resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
            ownership: createPiApiFirstTurnOwnership(),
          }),
        );
      }

      expect(requestBodies).toHaveLength(observedTiers.length);
      for (const body of requestBodies) {
        expect(body).toMatchObject({
          model: "openai/gpt-5.6-terra",
          service_tier: "priority",
          store: false,
        });
      }
      expect(
        results.map((result) => {
          return result.observedServiceTier;
        }),
      ).toStrictEqual(observedTiers);
      for (const result of results) {
        expect(result.sessionJsonl).not.toContain("serviceTier");
        expect(result.sessionJsonl).not.toContain("service_tier");
        expect(result.sessionJsonl).not.toContain("observedServiceTier");
      }
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

  it("resumes pre-migration OpenRouter Chat JSONL through full-context Responses", async () => {
    const providerRequests: Array<{
      readonly url: string | undefined;
      readonly body: unknown;
    }> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        providerRequests.push({
          url: request.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
        responsesTextSse(response, "post-migration answer", {
          serviceTier: "default",
        });
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
      throw new Error("OpenRouter migration test server has no TCP address");
    }
    const legacy = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    legacy.appendMessage({
      role: "user",
      content: "legacy user context",
      timestamp: 1,
    });
    legacy.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "legacy reasoning context" },
        { type: "text", text: "legacy answer context" },
        {
          type: "toolCall",
          id: "legacy_tool_call",
          name: "read",
          arguments: { path: "/home/user/workspace/AGENTS.md" },
        },
      ],
      api: "openai-completions",
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
      usage: {
        input: 4,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 7,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse",
      timestamp: 2,
    });
    legacy.appendMessage({
      role: "toolResult",
      toolCallId: "legacy_tool_call",
      toolName: "read",
      content: [{ type: "text", text: "legacy tool output" }],
      isError: false,
      timestamp: 3,
    });
    legacy.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "legacy tool conclusion" }],
      api: "openai-completions",
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
      usage: {
        input: 2,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 4,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 4,
    });

    try {
      const result = await runPiApiFirstTurn({
        cwd: "/home/user/workspace",
        agentDir: "/home/user/.pi/agent",
        sessionId: SESSION_ID,
        sessionJsonl: legacy.toJsonl(),
        prompt: "post-migration prompt",
        appendSystemPrompt: null,
        model: {
          provider: "openrouter",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test-key",
          model: "openai/gpt-5.6-terra",
          api: "openai-responses",
          thinkingLevel: "low",
        },
        resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
        ownership: createPiApiFirstTurnOwnership(),
      });

      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]?.url).toBe("/v1/responses");
      expect(providerRequests[0]?.body).toMatchObject({ store: false });
      expect(providerRequests[0]?.body).not.toHaveProperty(
        "previous_response_id",
      );
      const requestJson = JSON.stringify(providerRequests[0]?.body);
      for (const marker of [
        "legacy user context",
        "legacy reasoning context",
        "legacy answer context",
        "legacy tool output",
        "legacy tool conclusion",
        "post-migration prompt",
      ]) {
        expect(requestJson.split(marker)).toHaveLength(2);
      }
      expect(result.observedServiceTier).toBe("default");
      expect(result.assistantMessage.content).toStrictEqual([
        { type: "text", text: "post-migration answer" },
      ]);
      expect(inspectPiSessionJsonl(result.sessionJsonl)).toMatchObject({
        messageCount: 6,
        hasPendingToolCalls: false,
        isSettledCheckpoint: true,
      });
      for (const marker of [
        "legacy reasoning context",
        "legacy tool output",
        "post-migration prompt",
        "post-migration answer",
      ]) {
        expect(result.sessionJsonl.split(marker)).toHaveLength(2);
      }
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

  it("runs threshold-safe H0 once and blocks above-threshold H0 before transport", async () => {
    let providerRequests = 0;
    const server = createServer((_request, response) => {
      providerRequests += 1;
      responsesTextSse(response, "threshold-safe answer");
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
      throw new Error("Terra threshold test server has no TCP address");
    }
    const resolvedModel = resolvePiAgentModel({
      provider: "openai",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-key",
      model: "gpt-5.6-terra",
      api: "openai-responses",
    });
    if (!resolvedModel) {
      throw new Error("Expected pinned Pi to catalog Terra");
    }
    const threshold = resolvedModel.contextWindow - 16_384;
    const sessionJsonl = (totalTokens: number): string => {
      const session = MemoryPiSession.create({
        cwd: "/home/user/workspace",
        id: SESSION_ID,
      });
      session.appendMessage({
        role: "user",
        content: "prior prompt",
        timestamp: 1,
      });
      session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "prior answer" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.6-terra",
        usage: {
          input: totalTokens,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      return session.toJsonl();
    };
    const model = {
      provider: "openai" as const,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-key",
      model: "gpt-5.6-terra",
      api: "openai-responses" as const,
      thinkingLevel: "low" as const,
    };

    try {
      const safeOwnership = createPiApiFirstTurnOwnership();
      const safe = await runPiApiFirstTurn({
        cwd: "/home/user/workspace",
        agentDir: "/home/user/.pi/agent",
        sessionId: SESSION_ID,
        sessionJsonl: sessionJsonl(threshold),
        prompt: "safe threshold prompt",
        appendSystemPrompt: null,
        model,
        resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
        ownership: safeOwnership,
      });
      expect(providerRequests).toBe(1);
      expect(safeOwnership.stage).toBe("provider-may-have-started");
      expect(safe.sessionJsonl).toContain("safe threshold prompt");

      const blockedOwnership = createPiApiFirstTurnOwnership();
      await expect(
        runPiApiFirstTurn({
          cwd: "/home/user/workspace",
          agentDir: "/home/user/.pi/agent",
          sessionId: SESSION_ID,
          sessionJsonl: sessionJsonl(threshold + 1),
          prompt: "must remain sandbox-owned",
          appendSystemPrompt: null,
          model,
          resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
          ownership: blockedOwnership,
        }),
      ).rejects.toThrow(PiApiFirstTurnCompactionRequiredError);
      expect(providerRequests).toBe(1);
      expect(blockedOwnership.stage).toBe("pre-provider");
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
