import { stat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DriverMetadata,
  EmbeddedDriverConnection,
  EmbeddedDriverExit,
} from "@trycua/cua-driver";
import { CuaEmbeddedRuntime } from "./cua-runtime";
import { assertCuaDormant, type CuaSdk } from "./cua-runtime-files";
import { runCuaHostProbe } from "./cua-host-probe";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Only the external SDK/process boundary is replaced. The owner, deadlines,
// filesystem, host probe, and all generation/retirement logic remain real.
function externalSdk() {
  const events: string[] = [];
  const active = new Set<number>();
  const entered = deferred<void>();
  const captureEntered = deferred<void>();
  const sessions = new Set<string>();
  const hosts: Array<{
    connection: EmbeddedDriverConnection;
    exit: ReturnType<typeof deferred<EmbeddedDriverExit>>;
    directory: string;
  }> = [];
  let startGate: Promise<void> = Promise.resolve();
  let stopGate: Promise<void> = Promise.resolve();
  let metadataGate: Promise<void> = Promise.resolve();
  let captureGate: Promise<void> = Promise.resolve();
  let editMetadata = (value: DriverMetadata) => value;
  let editConnection = (value: EmbeddedDriverConnection) => value;
  let editExit = (value: EmbeddedDriverExit) => value;
  let granted = false;
  let clientDestroyed = false;
  const sdk: CuaSdk = {
    standardPermissionMode: 0,
    stoppedState: 0,
    createHost(options) {
      expect(options.permissionMode).toBe(0);
      expect(options.dangerouslyBypassApprovals).toBe(false);
      expect(options.environment).toEqual([
        { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "0" },
        { name: "CUA_TELEMETRY_ENABLED", value: "0" },
        {
          name: "HOME",
          value: options.socketPath!.slice(0, -"/driver.sock".length),
        },
      ]);
      expect(options.inheritStderr).toBe(false);
      const id = hosts.length + 1;
      const connection: EmbeddedDriverConnection = {
        socketPath: options.socketPath!,
        pid: id,
        generation: `native-${id}`,
        driverVersion: "0.23.2",
        contractVersion: "contract",
        mcpProtocolVersion: "mcp",
        mcp: { command: options.binaryPath, args: [], environment: [] },
      };
      const exit = deferred<EmbeddedDriverExit>();
      let state = 0;
      hosts.push({
        connection,
        exit,
        directory: connection.socketPath.slice(0, -"/driver.sock".length),
      });
      return {
        async start() {
          active.add(id);
          state = 1;
          events.push(`start-${id}`);
          entered.resolve();
          await startGate;
          state = 2;
          return editConnection(connection);
        },
        async stop() {
          events.push(`stop-${id}`);
          await startGate;
          await stopGate;
          active.delete(id);
          state = 0;
          exit.resolve(
            editExit({
              generation: connection.generation,
              success: true,
              code: 0,
            }),
          );
        },
        state: () => state,
        waitForExit: () => exit.promise,
        uniffiDestroy: () => {
          events.push(`destroy-host-${id}`);
        },
      };
    },
    connect(socket) {
      const host = hosts.find((item) => item.connection.socketPath === socket);
      if (!host) throw new Error("Not a host-owned connection");
      return {
        async metadata() {
          await metadataGate;
          return editMetadata({
            ...host.connection,
            embedded: true,
            hostBundleId: "ai.okou.desktop",
            toolsListSchemaVersion: "tools",
            capabilityVersion: "capabilities",
          });
        },
        async callTool(name, args) {
          expect(name).toBe("check_permissions");
          expect(JSON.parse(args)).toEqual({
            prompt: false,
            probe_direct_capture: false,
          });
          return {
            text: "",
            images: [],
            isError: false,
            degraded: false,
            rawJson: "{}",
            structuredJson: JSON.stringify({
              accessibility: granted,
              screen_recording: granted,
              source: { attribution: "host" },
            }),
          };
        },
        async startSession({ session }) {
          if (!granted || !session)
            throw new Error("Unexpected session allocation without capture");
          sessions.add(session);
          return {
            active: true,
            revived: false,
            state: {
              session,
              captureScope: 0,
              effectiveScope: 1,
              desktopCaptureAuthorized: true,
              desktopUnlocked: true,
            },
          };
        },
        async endSession({ session }) {
          if (!session) throw new Error("Missing host session");
          sessions.delete(session);
          events.push("end-session");
          return { session, active: false };
        },
        async getDesktopState({ session }) {
          if (!session || !sessions.has(session))
            throw new Error("Unowned capture session");
          captureEntered.resolve();
          await captureGate;
          return {
            text: "",
            images: [{ mimeType: "image/png", dataBase64: "iVBORw0KGgo=" }],
            isError: false,
            degraded: false,
            rawJson: "{}",
          };
        },
        uniffiDestroy() {
          clientDestroyed = true;
          events.push(`destroy-client-${host.connection.pid}`);
        },
      };
    },
  };
  return {
    sdk,
    events,
    active,
    hosts,
    entered,
    captureEntered,
    sessions,
    delayStart: (gate: Promise<void>) => {
      startGate = gate;
    },
    delayStop: (gate: Promise<void>) => {
      stopGate = gate;
    },
    delayMetadata: (gate: Promise<void>) => {
      metadataGate = gate;
    },
    delayCapture: (gate: Promise<void>) => {
      captureGate = gate;
    },
    metadata: (edit: typeof editMetadata) => {
      editMetadata = edit;
    },
    connection: (edit: typeof editConnection) => {
      editConnection = edit;
    },
    exit: (edit: typeof editExit) => {
      editExit = edit;
    },
    grant: () => {
      granted = true;
    },
    clientDestroyed: () => clientDestroyed,
  };
}

const runtimes: CuaEmbeddedRuntime[] = [];
function runtime(external = externalSdk(), deadlineMs = 1_000) {
  const owner = new CuaEmbeddedRuntime({
    runtimeRoot: "/packaged/cua",
    hostBundleId: "ai.okou.desktop",
    loadSdk: async () => external.sdk,
    deadlineMs,
  });
  runtimes.push(owner);
  return { owner, external };
}
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((item) => item.dispose()));
});

describe("embedded CUA host lifecycle", () => {
  it("is dormant until explicit start and coalesces concurrent starts", async () => {
    assertCuaDormant();
    const { owner, external } = runtime();
    expect(external.active.size).toBe(0);
    const first = owner.start();
    expect(owner.start()).toBe(first);
    expect(await first).toMatchObject({
      generation: 1,
      driverVersion: "0.23.2",
      metadata: { pid: 1, embedded: true, hostBundleId: "ai.okou.desktop" },
    });
    expect(external.active.size).toBe(1);
    expect((await stat(external.hosts[0]!.directory)).mode & 0o777).toBe(0o700);
    await Promise.all([owner.stop(), owner.stop()]);
    expect(external.active.size).toBe(0);
    expect(external.events.indexOf("stop-1")).toBeLessThan(
      external.events.indexOf("destroy-client-1"),
    );
    expect(external.events.at(-1)).toBe("destroy-host-1");
    expect(owner.getState().generation).toBeNull();
    expect(await owner.start()).toMatchObject({ generation: 2 });
  });

  it("retires a start before an asynchronously loaded SDK can allocate a child", async () => {
    const external = externalSdk();
    const load = deferred<CuaSdk>();
    const owner = new CuaEmbeddedRuntime({
      runtimeRoot: "/packaged/cua",
      hostBundleId: "ai.okou.desktop",
      loadSdk: () => load.promise,
    });
    runtimes.push(owner);
    const start = owner.start();
    const rejected = expect(start).rejects.toThrow("CUA startup failed");
    const stop = owner.stop();
    load.resolve(external.sdk);
    await Promise.all([rejected, stop]);
    expect(external.active.size).toBe(0);
    expect(external.hosts).toHaveLength(0);
  });

  it("owns a cancelled native start through its late connection and reaping", async () => {
    const { owner, external } = runtime();
    const gate = deferred<void>();
    external.delayStart(gate.promise);
    const start = expect(owner.start()).rejects.toThrow("CUA startup failed");
    await external.entered.promise;
    const stop = owner.stop();
    await expect(owner.start()).rejects.toThrow("retirement is unproven");
    expect(external.active.size).toBe(1);
    gate.resolve();
    await Promise.all([start, stop]);
    expect(external.active.size).toBe(0);
    expect(owner.getState().generation).toBeNull();
  });

  it.each([
    ["version", (m: DriverMetadata) => ({ ...m, driverVersion: "0.23.3" })],
    ["pid", (m: DriverMetadata) => ({ ...m, pid: 987 })],
    ["embedding", (m: DriverMetadata) => ({ ...m, embedded: false })],
    [
      "identity",
      (m: DriverMetadata) => ({ ...m, hostBundleId: "com.trycua.driver" }),
    ],
    [
      "protocol",
      (m: DriverMetadata) => ({ ...m, mcpProtocolVersion: "incompatible" }),
    ],
  ] as const)(
    "rejects incompatible %s metadata and cleans up",
    async (_name, edit) => {
      const { owner, external } = runtime();
      external.metadata(edit);
      await expect(owner.start()).rejects.toThrow("CUA startup failed");
      await owner.stop();
      expect(external.active.size).toBe(0);
      expect(external.clientDestroyed()).toBe(true);
    },
  );

  it("enforces the exact connection version even if the client metadata is pinned", async () => {
    const { owner, external } = runtime();
    external.connection((value) => ({ ...value, driverVersion: "0.23.1" }));
    await expect(owner.start()).rejects.toThrow("CUA startup failed");
    await owner.stop();
    expect(external.active.size).toBe(0);
  });

  it("rejects metadata arriving after stop without publishing readiness", async () => {
    const { owner, external } = runtime();
    const gate = deferred<void>();
    external.delayMetadata(gate.promise);
    const start = expect(owner.start()).rejects.toThrow("CUA startup failed");
    await external.entered.promise;
    const stop = owner.stop();
    gate.resolve();
    await Promise.all([start, stop]);
    expect(owner.getState().phase).not.toBe("ready");
    expect(external.active.size).toBe(0);
  });

  it("a caller shutdown timeout retains ownership until the delayed exit is confirmed", async () => {
    const { owner, external } = runtime(externalSdk(), 30);
    await owner.start();
    const stop = deferred<void>();
    external.delayStop(stop.promise);
    await expect(owner.stop()).rejects.toThrow("replacement remains blocked");
    await expect(owner.start()).rejects.toThrow("retirement is unproven");
    expect(external.active.size).toBe(1);
    stop.resolve();
    await owner.stop();
    expect(external.active.size).toBe(0);
    await owner.start();
    expect(external.hosts).toHaveLength(2);
  });

  it("a startup deadline cannot create a replacement for an unresolved native start", async () => {
    const { owner, external } = runtime(externalSdk(), 30);
    const gate = deferred<void>();
    external.delayStart(gate.promise);
    await expect(owner.start()).rejects.toThrow("CUA startup failed");
    await expect(owner.start()).rejects.toThrow("retirement is unproven");
    gate.resolve();
    await owner.stop();
    expect(external.active.size).toBe(0);
  });

  it("retains failed native stop ownership and never automatically falls back or restarts", async () => {
    const { owner, external } = runtime(externalSdk(), 30);
    await owner.start();
    const stop = deferred<void>();
    external.delayStop(stop.promise);
    const pending = expect(owner.stop()).rejects.toThrow(
      "replacement remains blocked",
    );
    stop.reject(new Error("unreaped"));
    await pending;
    await expect(owner.start()).rejects.toThrow("retirement is unproven");
    expect(external.hosts).toHaveLength(1);
    // The external process eventually exits, but failed stop proof remains blocked.
    external.active.clear();
    external.hosts[0]!.exit.resolve({ generation: "native-1", success: false });
  });

  it("invalidates an unexpected exit and requires an explicit new start", async () => {
    const { owner, external } = runtime();
    await owner.start();
    external.hosts[0]!.exit.resolve({
      generation: "native-1",
      success: false,
      code: 1,
    });
    await external.hosts[0]!.exit.promise;
    await owner.stop();
    expect(owner.getState().error).toBe("cua_unexpected_exit");
    expect(external.active.size).toBe(0);
    expect(external.hosts).toHaveLength(1);
    await owner.start();
    expect(owner.getState().generation).toBe(2);
  });

  it("rejects an exit observer for a different generation", async () => {
    const { owner, external } = runtime(externalSdk(), 30);
    await owner.start();
    external.hosts[0]!.exit.resolve({ generation: "stale", success: true });
    await expect(owner.stop()).rejects.toThrow("replacement remains blocked");
    await expect(owner.start()).rejects.toThrow("retirement is unproven");
    expect(external.hosts).toHaveLength(1);
  });

  it("reports missing runtime files only on explicit start", async () => {
    const owner = new CuaEmbeddedRuntime({
      runtimeRoot: "/missing-cua-payload",
      hostBundleId: "ai.okou.desktop",
    });
    runtimes.push(owner);
    expect(owner.getState().phase).toBe("stopped");
    await expect(owner.start()).rejects.toThrow("CUA startup failed");
    await owner.stop();
    expect(owner.getState().generation).toBeNull();
  });

  it("the host probe completes metadata/cleanup without TCC grants or screenshots", async () => {
    const { owner, external } = runtime();
    expect(
      await runCuaHostProbe(owner, false, "/unused-probe-output"),
    ).toMatchObject({
      driverVersion: "0.23.2",
      attribution: "host",
      accessibility: false,
      screenRecording: false,
      capture: "not_requested",
      cleanup: {
        generation: 1,
        exitObserved: true,
        exitSuccess: true,
        exitCode: 0,
        hostStopped: true,
        directoryRemoved: true,
      },
    });
    expect(external.active.size).toBe(0);
    await expect(owner.start()).rejects.toThrow("disposed");
  });

  it("does not call a force-killed or failed child a successful packaged probe", async () => {
    const { owner, external } = runtime();
    external.exit((exit) => ({ ...exit, success: false, code: undefined }));
    await expect(
      runCuaHostProbe(owner, false, "/unused-probe-output"),
    ).rejects.toThrow("clean process lifecycle");
    expect(external.active.size).toBe(0);
    expect(owner.getCleanupEvidence()).toMatchObject({
      exitObserved: true,
      exitSuccess: false,
      exitCode: null,
    });
    await expect(stat(external.hosts[0]!.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("explicit capture with missing TCC grants reports permission denial and cleans up", async () => {
    const { owner, external } = runtime();
    expect(
      await runCuaHostProbe(owner, true, "/unused-probe-output"),
    ).toMatchObject({
      capture: "permission_denied",
      cleanup: {
        generation: 1,
        exitObserved: true,
        exitSuccess: true,
        exitCode: 0,
        hostStopped: true,
        directoryRemoved: true,
      },
    });
    expect(external.active.size).toBe(0);
  });

  it("a granted host probe owns its explicit session and local image through cleanup", async () => {
    const { owner, external } = runtime();
    external.grant();
    const directory = await mkdtemp(path.join(tmpdir(), "cua-probe-test-"));
    try {
      const result = await runCuaHostProbe(owner, true, directory);
      expect(result).toMatchObject({
        capture: "success",
        cleanup: {
          generation: 1,
          exitObserved: true,
          exitSuccess: true,
          exitCode: 0,
          hostStopped: true,
          directoryRemoved: true,
        },
      });
      expect(JSON.stringify(result)).not.toContain("iVBOR");
      expect(
        await readFile(path.join(directory, "cua-host-probe/screenshot.png")),
      ).toEqual(Buffer.from("iVBORw0KGgo=", "base64"));
      expect(external.sessions.size).toBe(0);
      expect(external.active.size).toBe(0);
      expect(external.events.indexOf("end-session")).toBeLessThan(
        external.events.indexOf("destroy-client-1"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("a stopped probe cannot publish a late screenshot or overlap its client cleanup", async () => {
    const { owner, external } = runtime(externalSdk(), 30);
    external.grant();
    await owner.start();
    const gate = deferred<void>();
    external.delayCapture(gate.promise);
    const probe = expect(owner.probe(true)).rejects.toThrow(
      "CUA host probe failed",
    );
    await external.captureEntered.promise;
    await expect(owner.stop()).rejects.toThrow("replacement remains blocked");
    await expect(owner.start()).rejects.toThrow("retirement is unproven");
    expect(external.clientDestroyed()).toBe(false);
    gate.resolve();
    await probe;
    await owner.stop();
    expect(external.sessions.size).toBe(0);
    expect(external.active.size).toBe(0);
  });
});
