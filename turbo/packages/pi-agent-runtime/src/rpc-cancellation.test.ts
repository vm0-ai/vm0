import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { MemoryPiSession } from "./session-memory";

const SESSION_ID = "00000000-0000-4000-8000-000000000915";
const FIXTURE = fileURLToPath(
  new URL("./test/fixtures/pending-tool-rpc.ts", import.meta.url),
);
// Loaded by the real extension loader in the actual RPC host. IPC controls only
// the fixture tool's cooperative boundary; official commands still use stdin.
const EXTENSION = `import { writeFile } from "node:fs/promises";
export default function (pi) {
  if (process.argv[3] === "tool") pi.on("agent_settled", async () => {
    await new Promise((resolve) => {
      const release = (message) => {
        if (message === "release-settlement") {
          process.off("message", release);
          resolve();
        }
      };
      process.on("message", release);
      process.send({ type: "settling" });
    });
  });
  pi.registerTool({
    name: "controlled", label: "controlled", description: "Cooperative fixture",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute(_id, args, signal) {
      if (!signal) throw new Error("Missing native tool signal");
      const aborted = () => process.send({ type: "tool-aborted" });
      signal.addEventListener("abort", aborted, { once: true });
      await new Promise((resolve) => {
        const release = (message) => {
          if (message === "release-tool") {
            process.off("message", release);
            resolve();
          }
        };
        process.on("message", release);
        process.send({ type: "tool-start" });
      });
      signal.removeEventListener("abort", aborted);
      signal.throwIfAborted();
      await writeFile(args.path, "completed side effect");
      return { content: [{ type: "text", text: "done" }], details: {} };
    }
  });
}`;

describe("official pending-tool RPC cancellation", () => {
  it.each(["tool", "http"])(
    "acknowledges abort only after the owned %s boundary settles",
    async (boundary) => {
      const root = await mkdtemp(join(tmpdir(), "pi-pending-rpc-"));
      const effect = join(root, "effect.txt");
      const extensions = join(root, "agent", "extensions");
      await mkdir(extensions, { recursive: true });
      await writeFile(join(extensions, "controlled.js"), EXTENSION);
      const memory = MemoryPiSession.create({ cwd: root, id: SESSION_ID });
      memory.appendMessage({
        role: "user",
        content: "original handoff",
        timestamp: 1,
      });
      memory.appendMessage(
        fauxAssistantMessage(
          fauxToolCall("controlled", { path: effect }, { id: "call-0" }),
          { stopReason: "toolUse", timestamp: 2 },
        ),
      );
      await writeFile(join(root, "session.jsonl"), memory.toJsonl());
      const child = spawn(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), FIXTURE, root, boundary],
        {
          cwd: root,
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          // The parent owns a real kill deadline; no same-thread timeout can make
          // an unowned/hung native continuation look like successful settlement.
          timeout: 20_000,
          killSignal: "SIGKILL",
        },
      );
      const { stdin, stdout, stderr: errorStream } = child;
      if (!stdin || !stdout || !errorStream)
        throw new Error("RPC fixture requires piped stdio");
      const exit = once(child, "exit");
      const lines = createInterface({ input: stdout, crlfDelay: Infinity });
      const iterator = lines[Symbol.asyncIterator]();
      const records: Array<Record<string, unknown>> = [];
      const notifications: unknown[] = [];
      let stderr = "";
      errorStream.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("message", (message) => {
        notifications.push(message);
      });
      const send = (command: Record<string, unknown>) => {
        stdin.write(`${JSON.stringify(command)}\n`);
      };
      const response = async (id: string) => {
        for (;;) {
          const next = await iterator.next();
          if (next.done)
            throw new Error(`RPC host exited before ${id}: ${stderr}`);
          const record = JSON.parse(next.value) as Record<string, unknown>;
          records.push(record);
          if (record.type === "response" && record.id === id) return record;
        }
      };
      try {
        send({ id: "state", type: "get_state" });
        expect(await response("state")).toMatchObject({
          success: true,
          data: { sessionId: SESSION_ID },
        });
        const started = once(child, "message");
        send({ id: "startup", type: "prompt", message: "original handoff" });
        expect(await response("startup")).toMatchObject({
          command: "prompt",
          success: true,
        });
        expect((await started)[0]).toMatchObject({ type: "tool-start" });
        send({
          id: "busy",
          type: "prompt",
          message: "unowned concurrent prompt",
        });
        expect(await response("busy")).toMatchObject({ success: false });
        send({
          id: "steer",
          type: "steer",
          message: "acknowledged active input",
        });
        expect(await response("steer")).toMatchObject({ success: true });
        if (boundary === "http") {
          const requested = once(child, "message");
          child.send("release-tool");
          expect((await requested)[0]).toMatchObject({
            type: "http-start",
            count: 1,
          });
        }
        const cancelled = once(child, "message");
        send({ id: "abort", type: "abort" });
        send({ id: "duplicate-abort", type: "abort" });
        expect((await cancelled)[0]).toMatchObject({
          type: boundary === "tool" ? "tool-aborted" : "http-aborted",
        });
        if (boundary === "tool") {
          send({ id: "held", type: "get_state" });
          expect(await response("held")).toMatchObject({
            data: { isStreaming: true },
          });
          expect(
            records.some((record) => {
              return record.id === "abort" || record.type === "agent_settled";
            }),
          ).toBe(false);
          const settling = once(child, "message");
          child.send("release-tool");
          expect((await settling)[0]).toMatchObject({ type: "settling" });
          send({ id: "settlement-held", type: "get_state" });
          expect(await response("settlement-held")).toMatchObject({
            data: { isStreaming: true },
          });
          expect(
            records.some((record) => {
              return record.id === "abort" || record.type === "agent_settled";
            }),
          ).toBe(false);
          child.send("release-settlement");
        }
        expect(await response("abort")).toMatchObject({
          command: "abort",
          success: true,
        });
        expect(await response("duplicate-abort")).toMatchObject({
          command: "abort",
          success: true,
        });
        send({ id: "idle", type: "get_state" });
        expect(await response("idle")).toMatchObject({
          data: { isStreaming: false },
        });
        expect(
          records.filter((record) => {
            return record.type === "agent_settled";
          }),
        ).toHaveLength(1);
        const assistants = records.filter((record) => {
          const message = record.message;
          return (
            record.type === "message_end" &&
            typeof message === "object" &&
            message !== null &&
            "role" in message &&
            message.role === "assistant"
          );
        });
        expect(assistants).toHaveLength(1);
        expect(assistants[0]).toMatchObject({
          message: { stopReason: "aborted" },
        });
        if (boundary === "tool") {
          const terminal = assistants[0]?.message;
          if (typeof terminal !== "object" || terminal === null)
            throw new Error("Expected native aborted assistant");
          const expected: unknown = JSON.parse(
            await readFile(
              new URL(
                "./test/fixtures/pending-tool-abort.json",
                import.meta.url,
              ),
              "utf8",
            ),
          );
          expect([
            { type: "message_end", message: { ...terminal, timestamp: 0 } },
            records.find((record) => {
              return record.type === "agent_settled";
            }),
          ]).toEqual(expected);
        }
        const requestCount = () => {
          return notifications.filter((message) => {
            return (
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "http-start"
            );
          }).length;
        };
        expect(requestCount()).toBe(boundary === "http" ? 1 : 0);
        if (boundary === "tool")
          await expect(readFile(effect)).rejects.toMatchObject({
            code: "ENOENT",
          });
        else
          expect(await readFile(effect, "utf8")).toBe("completed side effect");
        stdin.end();
        expect(await exit, stderr).toEqual([0, null]);
        const persisted = MemoryPiSession.fromJsonl(
          await readFile(join(root, "session.jsonl"), "utf8"),
        );
        expect(persisted.getSessionId()).toBe(SESSION_ID);
        expect(persisted.buildSessionContext().messages.at(-1)).toMatchObject({
          stopReason: "aborted",
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await exit;
        lines.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
