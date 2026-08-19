import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { afterEach, describe, expect, it, vi } from "vitest";

import { resumePendingPiToolCalls } from "./session-recovery";
import {
  MemoryPiSession,
  runPiFirstModelTurn,
  runPiModelTurn,
} from "./session-memory";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const TOOL_CALL_ID = "tool-call-from-api";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-spike-"));
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

describe("Pi API first-turn memory spike", () => {
  it("round-trips native JSONL from API memory into sandbox file recovery", async () => {
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
    const nativeSessionFile = nativeSession.getSessionFile();
    if (!nativeSessionFile) {
      throw new Error("Expected the native Pi session to have a file");
    }
    const nativeJsonl = await readFile(nativeSessionFile, "utf8");

    const memorySession = MemoryPiSession.fromJsonl(nativeJsonl);
    expect(memorySession.toJsonl()).toBe(nativeJsonl);

    let apiContext: Context | undefined;
    const faux = createFauxCore({
      api: "pi-memory-spike",
      provider: "pi-memory-spike",
    });
    faux.setResponses([
      (context, options) => {
        apiContext = context;
        expect(options?.sessionId).toBe(SESSION_ID);
        return fauxAssistantMessage(
          fauxToolCall(
            "read",
            { path: "/home/user/.pi/agent/skills/example/SKILL.md" },
            { id: TOOL_CALL_ID },
          ),
          { stopReason: "toolUse", timestamp: 4 },
        );
      },
    ]);
    const firstTurn = await runPiFirstModelTurn({
      model: faux.getModel(),
      prompt: "use the example skill",
      session: memorySession,
      stream: faux.streamSimple,
      systemPrompt: "preheated Pi system prompt",
      timestamp: 3,
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: Type.Object({ path: Type.String() }),
        },
      ],
    });

    expect(firstTurn.handoffRequired).toBe(true);
    expect(faux.state.callCount).toBe(1);
    expect(apiContext?.systemPrompt).toBe("preheated Pi system prompt");
    expect(
      apiContext?.messages.map((message) => {
        return message.role;
      }),
    ).toStrictEqual(["user", "assistant", "user"]);
    expect(await readFile(nativeSessionFile, "utf8")).toBe(nativeJsonl);

    const handoffJsonl = memorySession.toJsonl();
    expect(handoffJsonl.startsWith(nativeJsonl)).toBe(true);
    const sandboxSessionFile = join(directory, "sandbox-handoff.jsonl");
    await writeFile(sandboxSessionFile, handoffJsonl);
    const sandboxSession = SessionManager.open(sandboxSessionFile);
    expect(sandboxSession.getSessionId()).toBe(SESSION_ID);
    expect(sandboxSession.buildSessionContext().messages.at(-1)).toStrictEqual(
      JSON.parse(JSON.stringify(firstTurn.assistantMessage)) as unknown,
    );

    const executeRead = vi.fn(async (args: Record<string, unknown>) => {
      return {
        content: [
          {
            type: "text" as const,
            text: `skill body for ${String(args.path)}`,
          },
        ],
      };
    });
    const toolResults = await resumePendingPiToolCalls({
      session: sandboxSession,
      tools: [{ name: "read", execute: executeRead }],
    });
    expect(executeRead).toHaveBeenCalledExactlyOnceWith(
      { path: "/home/user/.pi/agent/skills/example/SKILL.md" },
      undefined,
    );
    expect(toolResults).toMatchObject([
      {
        role: "toolResult",
        toolCallId: TOOL_CALL_ID,
        toolName: "read",
        isError: false,
      },
    ]);

    faux.appendResponses([
      (context) => {
        expect(context.messages.at(-1)).toMatchObject({
          role: "toolResult",
          toolCallId: TOOL_CALL_ID,
        });
        return fauxAssistantMessage("sandbox continuation complete", {
          timestamp: 5,
        });
      },
    ]);
    const sandboxTurn = await runPiModelTurn({
      model: faux.getModel(),
      session: sandboxSession,
      stream: faux.streamSimple,
      systemPrompt: "preheated Pi system prompt",
    });
    expect(sandboxTurn.handoffRequired).toBe(false);
    expect(faux.state.callCount).toBe(2);

    const reopenedSession = SessionManager.open(sandboxSessionFile);
    expect(reopenedSession.buildSessionContext().messages.at(-1)).toMatchObject(
      {
        role: "assistant",
        content: [{ type: "text", text: "sandbox continuation complete" }],
      },
    );
    await expect(
      resumePendingPiToolCalls({
        session: reopenedSession,
        tools: [{ name: "read", execute: executeRead }],
      }),
    ).resolves.toStrictEqual([]);
  });

  it("uses Pi's own migration before emitting sandbox-compatible JSONL", async () => {
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
        message: {
          role: "user",
          content: "legacy message",
          timestamp: 1,
        },
      },
    ]
      .map((entry) => {
        return JSON.stringify(entry);
      })
      .join("\n");
    const memorySession = MemoryPiSession.fromJsonl(legacyJsonl);

    expect(memorySession.getHeader().version).toBe(CURRENT_SESSION_VERSION);
    expect(memorySession.getEntries()[0]).toMatchObject({
      type: "message",
      parentId: null,
    });

    const directory = await temporaryDirectory();
    const migratedFile = join(directory, "migrated.jsonl");
    await writeFile(migratedFile, memorySession.toJsonl());
    const nativeSession = SessionManager.open(migratedFile);
    expect(nativeSession.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "legacy message" },
    ]);
  });

  it("matches Pi's compacted context projection before the model call", async () => {
    const directory = await temporaryDirectory();
    const nativeSession = SessionManager.create(
      "/home/user/workspace",
      directory,
      { id: SESSION_ID },
    );
    nativeSession.appendMessage({
      role: "user",
      content: "summarized user turn",
      timestamp: 1,
    });
    nativeSession.appendMessage(
      fauxAssistantMessage("summarized assistant turn", { timestamp: 2 }),
    );
    const firstKeptEntryId = nativeSession.appendMessage({
      role: "user",
      content: "kept user turn",
      timestamp: 3,
    });
    nativeSession.appendCompaction(
      "summary generated by Pi",
      firstKeptEntryId,
      42,
    );
    nativeSession.appendCustomMessageEntry(
      "api-marker",
      "custom context entry",
      true,
    );
    nativeSession.appendMessage(
      fauxAssistantMessage("assistant after compaction", { timestamp: 4 }),
    );
    const nativeSessionFile = nativeSession.getSessionFile();
    if (!nativeSessionFile) {
      throw new Error("Expected the native Pi session to have a file");
    }

    const memorySession = MemoryPiSession.fromJsonl(
      await readFile(nativeSessionFile, "utf8"),
    );
    const nativeContext =
      SessionManager.open(nativeSessionFile).buildSessionContext();
    expect(memorySession.buildSessionContext()).toStrictEqual(nativeContext);

    let apiContext: Context | undefined;
    const faux = createFauxCore({
      api: "pi-memory-spike",
      provider: "pi-memory-spike",
    });
    faux.setResponses([
      (context) => {
        apiContext = context;
        return fauxAssistantMessage("continued after compaction", {
          timestamp: 5,
        });
      },
    ]);
    await runPiModelTurn({
      model: faux.getModel(),
      session: memorySession,
      stream: faux.streamSimple,
      systemPrompt: "preheated Pi system prompt",
    });

    expect(apiContext?.messages).toStrictEqual(
      convertToLlm(nativeContext.messages),
    );
  });
});
