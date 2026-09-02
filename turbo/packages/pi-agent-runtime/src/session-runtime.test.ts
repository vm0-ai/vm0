import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createPiAgentSessionForRuntime } from "./session-runtime";
import { piMemorySummaryTokenCount } from "./memory-recall";

const TERRA_MODEL = {
  provider: "openai" as const,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
  model: "gpt-5.6-terra",
  api: "openai-responses" as const,
  thinkingLevel: "low" as const,
};

const EMPTY_RESOURCE_SNAPSHOT = {
  schemaVersion: 1 as const,
  agentsFiles: [],
  skills: [],
};

function responsesTextSse(response: ServerResponse, text: string): void {
  const responseId = "resp_terra_sandbox";
  const messageId = "msg_terra_sandbox";
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

describe("official Pi AgentSession runtime", () => {
  it.each([
    {
      name: "standard",
      api: "openai-completions",
      serviceTier: undefined,
    },
    {
      name: "fast",
      api: "openai-codex-responses",
      serviceTier: "priority",
    },
  ] as const)(
    "normalizes legacy transport for $name Sandbox turns",
    async ({ api, serviceTier }) => {
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
          responsesTextSse(response, "Terra Sandbox answer");
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
        throw new Error("Terra Sandbox test server has no TCP address");
      }
      const sessionManager = SessionManager.inMemory("/home/user/workspace", {
        id: "00000000-0000-4000-8000-000000000126",
      });
      const created = await createPiAgentSessionForRuntime({
        cwd: "/home/user/workspace",
        agentDir: "/home/user/.pi/agent",
        sessionManager,
        model: {
          ...TERRA_MODEL,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api,
          ...(serviceTier === undefined ? {} : { serviceTier }),
        },
        appendSystemPrompt: null,
        resourceSnapshot: EMPTY_RESOURCE_SNAPSHOT,
      });

      try {
        await created.session.prompt("answer through the Sandbox");

        expect(providerRequests).toHaveLength(1);
        expect(providerRequests[0]).toMatchObject({
          url: "/v1/responses",
          body: {
            model: "gpt-5.6-terra",
            reasoning: { effort: "low" },
          },
        });
        if (serviceTier === undefined) {
          expect(providerRequests[0]?.body).not.toHaveProperty("service_tier");
        } else {
          expect(providerRequests[0]?.body).toMatchObject({
            service_tier: "priority",
          });
        }
      } finally {
        created.session.dispose();
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
    },
  );

  it("appends one lower-priority memory block after caller instructions", async () => {
    const sessionManager = SessionManager.inMemory("/home/user/workspace", {
      id: "00000000-0000-4000-8000-000000000123",
    });
    const content = "# Frozen memory\n\nPrefer targeted verification.";
    const outcomes: unknown[] = [];
    const created = await createPiAgentSessionForRuntime({
      cwd: "/home/user/workspace",
      agentDir: "/home/user/.pi/agent",
      sessionManager,
      model: TERRA_MODEL,
      appendSystemPrompt: "Caller instructions stay authoritative.",
      resourceSnapshot: {
        schemaVersion: 2,
        agentsFiles: [],
        skills: [],
        memoryRecall: {
          status: "ready",
          memoryStorageId: "memory-storage",
          storageVersionId: "memory-version-a",
          content,
          sourceHash: createHash("sha256").update(content).digest("hex"),
          sourceSize: Buffer.byteLength(content),
          tokenCount: piMemorySummaryTokenCount(content),
        },
      },
      onMemoryRecallOutcome(outcome) {
        outcomes.push(outcome);
      },
    });

    try {
      const callerIndex = created.session.systemPrompt.indexOf(
        "Caller instructions stay authoritative.",
      );
      const memoryIndex = created.session.systemPrompt.indexOf("## Memory");
      expect(callerIndex).toBeGreaterThanOrEqual(0);
      expect(memoryIndex).toBeGreaterThan(callerIndex);
      expect(created.session.systemPrompt.match(/## Memory/gu)).toHaveLength(1);
      expect(created.session.systemPrompt).toContain(content);
      expect(outcomes).toEqual([
        expect.objectContaining({
          mode: "api-first",
          status: "hit",
          parity: "frozen-match",
        }),
      ]);
      expect(JSON.stringify(sessionManager.getBranch())).not.toContain(content);
    } finally {
      created.session.dispose();
    }
  });

  it("authenticates and appends the frozen sandbox memory exactly once", async () => {
    const memoryRoot = await mkdtemp(join(tmpdir(), "pi-memory-recall-"));
    const content = "# Frozen memory\n\nKeep the sandbox epoch pinned.";
    await writeFile(join(memoryRoot, "memory_summary.md"), content);
    const sessionManager = SessionManager.inMemory("/home/user/workspace", {
      id: "00000000-0000-4000-8000-000000000127",
    });
    const outcomes: unknown[] = [];
    const created = await createPiAgentSessionForRuntime({
      cwd: "/home/user/workspace",
      agentDir: "/home/user/.pi/agent",
      sessionManager,
      model: TERRA_MODEL,
      appendSystemPrompt: "Caller instructions stay authoritative.",
      memoryRoot,
      memoryRecall: {
        status: "ready",
        memoryStorageId: "memory-storage",
        storageVersionId: "memory-version-a",
        content,
        sourceHash: createHash("sha256").update(content).digest("hex"),
        sourceSize: Buffer.byteLength(content),
        tokenCount: piMemorySummaryTokenCount(content),
      },
      onMemoryRecallOutcome(outcome) {
        outcomes.push(outcome);
      },
    });

    try {
      const callerIndex = created.session.systemPrompt.indexOf(
        "Caller instructions stay authoritative.",
      );
      const memoryIndex = created.session.systemPrompt.indexOf("## Memory");
      expect(callerIndex).toBeGreaterThanOrEqual(0);
      expect(memoryIndex).toBeGreaterThan(callerIndex);
      expect(created.session.systemPrompt.match(/## Memory/gu)).toHaveLength(1);
      expect(created.session.systemPrompt).toContain(content);
      expect(outcomes).toEqual([
        expect.objectContaining({
          mode: "sandbox",
          status: "hit",
          parity: "frozen-match",
        }),
      ]);
      expect(JSON.stringify(sessionManager.getBranch())).not.toContain(content);
    } finally {
      created.session.dispose();
      await rm(memoryRoot, { recursive: true });
    }
  });

  it("uses Terra low thinking for a fresh session", async () => {
    const sessionManager = SessionManager.inMemory("/home/user/workspace", {
      id: "00000000-0000-4000-8000-000000000124",
    });
    const created = await createPiAgentSessionForRuntime({
      cwd: "/home/user/workspace",
      agentDir: "/home/user/.pi/agent",
      sessionManager,
      model: TERRA_MODEL,
      appendSystemPrompt: null,
      resourceSnapshot: EMPTY_RESOURCE_SNAPSHOT,
    });

    try {
      expect(created.session.agent.state.thinkingLevel).toBe("low");
      expect(
        sessionManager.getBranch().filter((entry) => {
          return entry.type === "thinking_level_change";
        }),
      ).toEqual([expect.objectContaining({ thinkingLevel: "low" })]);
    } finally {
      created.session.dispose();
    }
  });

  it("keeps an existing explicit session thinking level authoritative", async () => {
    const sessionManager = SessionManager.inMemory("/home/user/workspace", {
      id: "00000000-0000-4000-8000-000000000125",
    });
    sessionManager.appendThinkingLevelChange("high");
    sessionManager.appendMessage({
      role: "user",
      content: "historical prompt",
      timestamp: 1,
    });
    sessionManager.appendMessage(
      fauxAssistantMessage("historical answer", { timestamp: 2 }),
    );
    const created = await createPiAgentSessionForRuntime({
      cwd: "/home/user/workspace",
      agentDir: "/home/user/.pi/agent",
      sessionManager,
      model: TERRA_MODEL,
      appendSystemPrompt: null,
      resourceSnapshot: EMPTY_RESOURCE_SNAPSHOT,
    });

    try {
      expect(created.session.agent.state.thinkingLevel).toBe("high");
      expect(
        sessionManager.getBranch().filter((entry) => {
          return entry.type === "thinking_level_change";
        }),
      ).toHaveLength(1);
    } finally {
      created.session.dispose();
    }
  });
});
