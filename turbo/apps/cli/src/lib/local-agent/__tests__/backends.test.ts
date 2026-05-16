import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeLocalAgentBackend } from "../backends";

const safeSpawnMock = vi.hoisted(() => {
  return vi.fn();
});

vi.mock("../../utils/spawn", () => {
  return {
    safeSpawn: safeSpawnMock,
  };
});

interface SpawnCall {
  command: string;
  args: string[];
}

const spawnCalls: SpawnCall[] = [];

function mockSuccessfulSpawn(): void {
  safeSpawnMock.mockImplementation((command: string, args: string[]) => {
    spawnCalls.push({ command, args });

    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    queueMicrotask(() => {
      child.emit("close", 0);
    });

    return child;
  });
}

describe("local-agent backends", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    safeSpawnMock.mockReset();
    mockSuccessfulSpawn();
  });

  it("passes extra Claude args through to Claude Code jobs", async () => {
    await executeLocalAgentBackend({
      backend: "claude-code",
      prompt: "summarize this",
      workdir: "/tmp",
      permissionMode: "default",
      claudeArgs: ["--chrome", "--model=sonnet"],
    });

    expect(spawnCalls).toEqual([
      {
        command: "claude",
        args: ["-p", "--chrome", "--model=sonnet", "summarize this"],
      },
    ]);
  });

  it("does not pass Claude args to Codex jobs", async () => {
    await executeLocalAgentBackend({
      backend: "codex",
      prompt: "summarize this",
      workdir: "/tmp",
      permissionMode: "default",
      claudeArgs: ["--chrome"],
    });

    expect(spawnCalls).toEqual([
      {
        command: "codex",
        args: ["exec", "summarize this"],
      },
    ]);
  });
});
