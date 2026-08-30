import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  Type,
  type Context,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  CURRENT_SESSION_VERSION,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryPiSession, runPiFirstModelTurn } from "./session-memory";
import { UnsupportedPiSessionVersionError } from "./errors";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-session-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("MemoryPiSession", () => {
  it("round-trips native Pi JSONL and appends one API model turn", async () => {
    const directory = await temporaryDirectory();
    const nativeSession = SessionManager.create(
      "/home/user/workspace",
      directory,
      {
        id: SESSION_ID,
      },
    );
    nativeSession.appendMessage({
      role: "user",
      content: "historical question",
      timestamp: 1,
    });
    nativeSession.appendMessage(
      fauxAssistantMessage("historical answer", { timestamp: 2 }),
    );
    const sessionFile = nativeSession.getSessionFile();
    if (!sessionFile) {
      throw new Error("Expected Pi to create a native session file");
    }
    const nativeJsonl = await readFile(sessionFile, "utf8");
    const memory = MemoryPiSession.fromJsonl(nativeJsonl);
    expect(memory.toJsonl()).toBe(nativeJsonl);

    let modelContext: Context | undefined;
    const faux = createFauxCore({
      api: "memory-test",
      provider: "memory-test",
    });
    faux.setResponses([
      (context, options) => {
        modelContext = context;
        expect(options?.sessionId).toBe(SESSION_ID);
        return fauxAssistantMessage(
          fauxToolCall("read", { path: "/workspace/AGENTS.md" }),
          { stopReason: "toolUse", timestamp: 4 },
        );
      },
    ]);
    const turn = await runPiFirstModelTurn({
      model: faux.getModel(),
      session: memory,
      stream: faux.streamSimple,
      systemPrompt: "preheated Pi system prompt",
      prompt: "continue from history",
      timestamp: 3,
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: Type.Object({ path: Type.String() }),
        },
      ],
    });

    expect(turn.handoffRequired).toBe(true);
    expect(faux.state.callCount).toBe(1);
    expect(modelContext?.systemPrompt).toBe("preheated Pi system prompt");
    expect(
      modelContext?.messages.map((message) => {
        return message.role;
      }),
    ).toStrictEqual(["user", "assistant", "user"]);
    expect(memory.toJsonl().startsWith(nativeJsonl)).toBe(true);
    expect(await readFile(sessionFile, "utf8")).toBe(nativeJsonl);
  });

  it("persists Pi's default thinking level before an API-first tool handoff", async () => {
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    const faux = createFauxCore({
      api: "memory-reasoning-test",
      provider: "memory-reasoning-test",
      models: [
        {
          id: "reasoning-model",
          reasoning: true,
          input: ["text"],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: 128_000,
          maxTokens: 16_384,
        },
      ],
    });
    const model = {
      ...faux.getModel(),
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        max: "max",
      },
    };
    let requestedReasoning: string | undefined;
    faux.setResponses([
      (_context, options) => {
        requestedReasoning = options?.reasoning;
        return fauxAssistantMessage(
          fauxToolCall("read", { path: "/etc/os-release" }),
          { stopReason: "toolUse", timestamp: 2 },
        );
      },
    ]);

    await runPiFirstModelTurn({
      model,
      session: memory,
      stream: faux.streamSimple,
      systemPrompt: "system",
      prompt: "read the operating system release",
      timestamp: 1,
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: Type.Object({ path: Type.String() }),
        },
      ],
    });

    expect(requestedReasoning).toBe("high");
    const entries = memory
      .toJsonl()
      .trim()
      .split("\n")
      .map((line) => {
        return JSON.parse(line) as {
          readonly type: string;
          readonly thinkingLevel?: string;
        };
      });
    expect(
      entries.map((entry) => {
        return entry.type;
      }),
    ).toStrictEqual([
      "session",
      "model_change",
      "thinking_level_change",
      "message",
      "message",
    ]);
    expect(entries[2]?.thinkingLevel).toBe("high");
    expect(
      MemoryPiSession.fromJsonl(memory.toJsonl()).buildSessionContext()
        .thinkingLevel,
    ).toBe("high");
  });

  it("uses Pi migrations and compacted-context projection", async () => {
    const legacyJsonl = [
      {
        type: "session",
        id: SESSION_ID,
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: "/home/user/workspace",
      },
      {
        type: "message",
        timestamp: "2025-01-01T00:00:01.000Z",
        message: { role: "user", content: "legacy message", timestamp: 1 },
      },
    ]
      .map((entry) => {
        return JSON.stringify(entry);
      })
      .join("\n");
    const migrated = MemoryPiSession.fromJsonl(legacyJsonl);
    expect(migrated.getHeader().version).toBe(CURRENT_SESSION_VERSION);

    const directory = await temporaryDirectory();
    const nativeSession = SessionManager.create(
      "/home/user/workspace",
      directory,
      {
        id: SESSION_ID,
      },
    );
    nativeSession.appendMessage({
      role: "user",
      content: "summarized turn",
      timestamp: 1,
    });
    const firstKeptEntryId = nativeSession.appendMessage({
      role: "user",
      content: "kept turn",
      timestamp: 2,
    });
    nativeSession.appendCompaction(
      "Pi generated summary",
      firstKeptEntryId,
      42,
    );
    nativeSession.appendMessage(
      fauxAssistantMessage("after compaction", { timestamp: 3 }),
    );
    const sessionFile = nativeSession.getSessionFile();
    if (!sessionFile) {
      throw new Error("Expected Pi to create a native session file");
    }
    const memory = MemoryPiSession.fromJsonl(
      await readFile(sessionFile, "utf8"),
    );
    const nativeContext = nativeSession.buildSessionContext();
    expect(memory.buildSessionContext()).toStrictEqual(
      JSON.parse(JSON.stringify(nativeContext)) as unknown,
    );
    expect(
      JSON.parse(
        JSON.stringify(convertToLlm(memory.buildSessionContext().messages)),
      ),
    ).toStrictEqual(
      JSON.parse(
        JSON.stringify(convertToLlm(nativeContext.messages)),
      ) as unknown,
    );
  });

  it("rejects a future Pi session version without invoking the model", () => {
    const futureJsonl = `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION + 1,
      id: SESSION_ID,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/home/user/workspace",
    })}\n`;

    expect(() => {
      return MemoryPiSession.fromJsonl(futureJsonl);
    }).toThrow(UnsupportedPiSessionVersionError);
  });

  it("rejects a malformed line after a valid native session header", () => {
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });

    expect(() => {
      return MemoryPiSession.fromJsonl(`${memory.toJsonl()}{malformed\n`);
    }).toThrow(SyntaxError);
  });

  it("distinguishes a pending handoff from a settled native checkpoint", () => {
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    memory.appendMessage({ role: "user", content: "read it", timestamp: 1 });
    const pending = fauxAssistantMessage(
      fauxToolCall("read", { path: "/home/user/workspace/README.md" }),
      { stopReason: "toolUse", timestamp: 2 },
    );
    memory.appendMessage(pending);

    expect(memory.hasPendingToolCalls()).toBe(true);
    expect(memory.isSettledCheckpoint()).toBe(false);
    const call = pending.content.find((content) => {
      return content.type === "toolCall";
    });
    if (!call || call.type !== "toolCall") {
      throw new Error("Expected a pending tool call");
    }
    memory.appendMessage({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "contents" }],
      isError: false,
      timestamp: 3,
    });

    expect(memory.hasPendingToolCalls()).toBe(false);
    expect(memory.isSettledCheckpoint()).toBe(false);
    memory.appendMessage(
      fauxAssistantMessage("done", { stopReason: "stop", timestamp: 4 }),
    );
    expect(memory.isSettledCheckpoint()).toBe(true);
  });
});
