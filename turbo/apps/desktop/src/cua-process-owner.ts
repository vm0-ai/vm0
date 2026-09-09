import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  CUA_MAX_PENDING,
  CUA_REPLY_BYTES,
  CUA_REQUEST_BYTES,
  cuaMonotonicMs,
  cuaReplySchema,
  cuaRequestSchema,
  readCuaFrames,
  type CuaOperation,
} from "./cua-process-protocol";

const sampleSchema = z
  .object({
    pid: z.number().int(),
    waitError: z.number().int(),
    exited: z.union([z.literal(0), z.literal(1)]),
    exitCode: z.number().int(),
    exitStatus: z.number().int(),
    remaining: z.number().int().min(-1).max(4096),
  })
  .strict();
interface NativeOwner {
  launch(args: string[]): unknown;
  pulse(): unknown;
  force(pid: number): unknown;
  sample(): unknown;
  reap(): unknown;
}
function isNativeOwner(value: unknown): value is NativeOwner {
  return (
    typeof value === "object" &&
    value !== null &&
    "launch" in value &&
    typeof value.launch === "function" &&
    "pulse" in value &&
    typeof value.pulse === "function" &&
    "force" in value &&
    typeof value.force === "function" &&
    "sample" in value &&
    typeof value.sample === "function" &&
    "reap" in value &&
    typeof value.reap === "function"
  );
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  release(): void;
}
export interface CuaProcessProof {
  readonly guardianPid: number | null;
  readonly guardianExitObserved: boolean;
  readonly descendantsExited: boolean;
  readonly forced: boolean;
  readonly elapsedMs: number;
  readonly heartbeatCount: number;
}

export class CuaProcessOwner {
  private native: NativeOwner | null = null;
  private pid: number | null = null;
  private socket: Socket | null = null;
  private server = createServer();
  private launch: Promise<void> | null = null;
  private launchSettled = false;
  private nextRequest = 0;
  private pending = new Map<number, Pending>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private beats = 0;
  private retired = false;
  private faulted = false;
  private until = 0;
  private remaining: (() => number) | null = null;

  constructor(
    private readonly root: string,
    private readonly directory: string,
    private readonly bundleId: string,
    private readonly generation: number,
    private readonly onFailure: () => void,
    private readonly blockCleanup = false,
  ) {}

  setBudget(remaining: (() => number) | null): void {
    this.remaining = remaining;
  }

  private async initialize(): Promise<void> {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new Error("CUA requires packaged macOS arm64 supervision");
    const nativeRoot = path.join(path.dirname(this.root), "native");
    const names = [
      path.join(nativeRoot, "cua-owner.node"),
      path.join(nativeRoot, "cua-guardian"),
      path.join(nativeRoot, "cua-sdk-process.js"),
    ];
    for (const file of names) {
      if (!(await lstat(file)).isFile() || (await realpath(file)) !== file)
        throw new Error("Invalid CUA lifecycle resource");
    }
    const load = createRequire(path.join(this.root, "cua-runtime.cjs"));
    const native: unknown = load(names[0]!);
    if (!isNativeOwner(native)) throw new Error("Invalid CUA lifecycle module");
    this.native = native;
    const connected = new Promise<void>((resolve, reject) => {
      this.server.once("connection", (socket) => {
        if (this.socket) {
          socket.destroy();
          return;
        }
        this.socket = socket;
        socket.on("error", () => this.fail());
        socket.on("close", () => this.fail());
        readCuaFrames(
          socket,
          CUA_REPLY_BYTES,
          (value) => this.receive(value),
          () => this.fail(),
        );
        resolve();
      });
      this.server.once("error", reject);
      this.server.once("close", () => {
        if (!this.socket)
          reject(new Error("CUA connection closed before startup"));
      });
    });
    void connected.catch(() => {});
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(path.join(this.directory, "rpc.sock"), resolve);
    });
    if (this.retired) throw new Error("CUA retired before process launch");
    this.pid = z
      .number()
      .int()
      .positive()
      .parse(
        this.native.launch([
          names[1]!,
          process.execPath,
          names[2]!,
          this.root,
          this.directory,
          this.bundleId,
          `${this.generation}${this.blockCleanup ? ":block-cleanup" : ""}`,
        ]),
      );
    this.heartbeat = setInterval(() => {
      this.beats++;
      try {
        this.native?.pulse();
        if (
          !this.retired &&
          this.native &&
          sampleSchema.parse(this.native.sample()).exited
        )
          this.fail();
      } catch {
        this.fail();
      }
    }, 50);
    await connected;
    this.server.close();
  }

  async request<T>(
    operation: CuaOperation,
    result: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.launch) {
      if (this.retired) throw new Error("CUA retired before launch");
      this.launch = this.initialize().finally(() => {
        this.launchSettled = true;
      });
    }
    await this.launch;
    const socket = this.socket;
    if (
      !socket ||
      this.faulted ||
      signal?.aborted ||
      this.pending.size >= CUA_MAX_PENDING ||
      socket.writableLength > CUA_REQUEST_BYTES
    )
      throw new Error("CUA channel unavailable or backpressured");
    const id = ++this.nextRequest;
    const remaining = this.retired
      ? this.until - cuaMonotonicMs()
      : Math.min(this.remaining?.() ?? 15_000, 120_000);
    const request = cuaRequestSchema.parse({
      generation: this.generation,
      id,
      expiresAt: cuaMonotonicMs() + remaining,
      operation,
    });
    const frame = JSON.stringify(request) + "\n";
    if (remaining <= 0 || Buffer.byteLength(frame) > CUA_REQUEST_BYTES)
      throw new Error("CUA request expired or oversized");
    const response = new Promise<unknown>((resolve, reject) => {
      const cancel = () => {
        if (
          this.socket?.writable &&
          this.socket.writableLength <= CUA_REQUEST_BYTES
        )
          this.socket.write(
            JSON.stringify({ generation: this.generation, cancel: id }) + "\n",
          );
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        release: () => signal?.removeEventListener("abort", cancel),
      });
      socket.write(frame);
    });
    return result.parse(await response);
  }

  private receive(value: unknown): void {
    const response = cuaReplySchema.parse(value);
    const pending = this.pending.get(response.id);
    if (response.generation !== this.generation || !pending) {
      this.fail();
      return;
    }
    this.pending.delete(response.id);
    pending.release();
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new Error("CUA remote operation failed"));
  }

  private fail(): void {
    if (this.faulted) return;
    this.faulted = true;
    for (const pending of this.pending.values()) {
      pending.release();
      pending.reject(new Error("CUA process disconnected"));
    }
    this.pending.clear();
    this.socket?.destroy();
    if (!this.retired) this.onFailure();
  }

  async retire<T>(
    graceful: () => Promise<T>,
    until: number,
  ): Promise<{ native: T | null; process: CuaProcessProof }> {
    this.retired = true;
    const started = cuaMonotonicMs();
    const initialBeats = this.beats;
    this.until = until;
    let native: T | null = null;
    let gracefulDone = false;
    const grace = graceful().then(async (value) => {
      await Promise.resolve();
      while (this.pending.size > 0 && cuaMonotonicMs() < until)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (this.pid !== null)
        await this.request({ method: "finish", input: {} }, z.null());
      native = value;
      gracefulDone = true;
    });
    void grace.catch(() => {});
    let forced = false;
    const forceAt = until - 2000;
    while (cuaMonotonicMs() < until) {
      if (this.pid === null && (!this.launch || this.launchSettled)) {
        this.server.close();
        return {
          native,
          process: {
            guardianPid: null,
            guardianExitObserved: true,
            descendantsExited: true,
            forced: false,
            elapsedMs: cuaMonotonicMs() - started,
            heartbeatCount: this.beats - initialBeats,
          },
        };
      }
      if (this.pid !== null && this.native) {
        if (cuaMonotonicMs() >= forceAt) {
          forced = true;
          this.native.force(this.pid);
        }
        const state = sampleSchema.parse(this.native.sample());
        if (
          state.pid === this.pid &&
          state.waitError === 0 &&
          state.exited &&
          state.remaining === 0
        ) {
          const guardianPid = this.pid;
          this.native.reap();
          this.pid = null;
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.socket?.destroy();
          this.server.close();
          this.fail();
          return {
            native: gracefulDone ? native : null,
            process: {
              guardianPid,
              guardianExitObserved: true,
              descendantsExited: true,
              forced: forced || !gracefulDone,
              elapsedMs: cuaMonotonicMs() - started,
              heartbeatCount: this.beats - initialBeats,
            },
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The live owner and waitable reservation remain: no replacement is legal.
    throw new Error("CUA cleanup_unproven: process ownership retained");
  }
}
