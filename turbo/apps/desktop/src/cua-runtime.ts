import { chmod, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type {
  DriverMetadata,
  EmbeddedDriverConnection,
  EmbeddedDriverExit,
} from "@trycua/cua-driver";
import artifacts from "../cua/artifacts.json";
import { loadPackagedCuaSdk, type CuaSdk } from "./cua-runtime-files";
import { withComputerUseDeadline } from "./computer-use-lifecycle-deadline";

interface CuaReadiness {
  readonly generation: number;
  readonly driverVersion: string;
}

interface Generation {
  readonly id: number;
  readonly abort: AbortController;
  retired: boolean;
  directory: string | null;
  sdk: CuaSdk | null;
  host: ReturnType<CuaSdk["createHost"]> | null;
  client: ReturnType<CuaSdk["connect"]> | null;
  connection: EmbeddedDriverConnection | null;
  exit: Promise<EmbeddedDriverExit> | null;
  initialization: Promise<CuaReadiness>;
  startResult: Promise<CuaReadiness>;
  retirement: Promise<void> | null;
  probe: Promise<CuaProbeResult> | null;
}

interface CuaProbeResult {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
  readonly attribution: "host";
  readonly screenshot: string | null;
}

interface RuntimeOptions {
  readonly runtimeRoot: string;
  readonly hostBundleId: string;
  /** External SDK boundary for deterministic fault injection. */
  readonly loadSdk?: () => Promise<CuaSdk>;
  readonly deadlineMs?: number;
}

/** Owns the real embedded daemon, without registering a partial command driver. */
export class CuaEmbeddedRuntime {
  private context: Generation | null = null;
  private nextGeneration = 0;
  private closed = false;
  private phase: "stopped" | "starting" | "ready" | "retiring" | "error" =
    "stopped";
  private error: string | null = null;

  constructor(private readonly options: RuntimeOptions) {}

  getState() {
    return {
      phase: this.phase,
      generation: this.context?.id ?? null,
      driverVersion: artifacts.driverVersion,
      error: this.error,
    };
  }

  start(): Promise<CuaReadiness> {
    if (this.closed)
      return Promise.reject(new Error("CUA runtime is disposed"));
    if (this.context)
      return this.context.retired
        ? Promise.reject(
            new Error("CUA prior generation retirement is unproven"),
          )
        : this.context.startResult;

    const context: Generation = {
      id: ++this.nextGeneration,
      abort: new AbortController(),
      retired: false,
      directory: null,
      sdk: null,
      host: null,
      client: null,
      connection: null,
      exit: null,
      retirement: null,
      probe: null,
      initialization: Promise.resolve().then(() => this.initialize(context)),
      startResult: Promise.resolve().then(() => this.startGeneration(context)),
    };
    this.context = context;
    this.phase = "starting";
    this.error = null;
    return context.startResult;
  }

  private async startGeneration(context: Generation): Promise<CuaReadiness> {
    try {
      return await withComputerUseDeadline(
        context.initialization,
        this.options.deadlineMs ?? 15_000,
      );
    } catch {
      if (!context.retired) this.fail(context, "cua_start_failed");
      throw new Error("CUA startup failed; generation cleanup remains owned");
    }
  }

  private assertCurrent(context: Generation): void {
    if (context.retired || this.context !== context)
      throw new Error("CUA generation was retired");
  }

  private async initialize(context: Generation): Promise<CuaReadiness> {
    const sdk = await (this.options.loadSdk?.() ??
      loadPackagedCuaSdk(this.options.runtimeRoot));
    this.assertCurrent(context);
    context.sdk = sdk;
    // A short, mode-0700 directory avoids macOS's Unix socket path limit and
    // prevents other users from connecting to the host-owned endpoint.
    context.directory = await mkdtemp("/tmp/okou-cua-");
    await chmod(context.directory, 0o700);
    this.assertCurrent(context);
    context.host = sdk.createHost({
      binaryPath: path.join(this.options.runtimeRoot, "cua-driver"),
      hostBundleId: this.options.hostBundleId,
      socketPath: path.join(context.directory, "driver.sock"),
      startupTimeoutMs: 10_000n,
      shutdownTimeoutMs: 2_000n,
      permissionMode: sdk.standardPermissionMode,
      approveCapabilityManifest: false,
      approveSessionPolicy: false,
      dangerouslyBypassApprovals: false,
      environment: [
        { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "0" },
        { name: "CUA_TELEMETRY_ENABLED", value: "0" },
        // The released daemon reads history opt-in from HOME. A fresh child-only
        // home prevents inheriting standalone CUA preferences or collecting history.
        // The Electron host environment and macOS responsibility chain are unchanged.
        { name: "HOME", value: context.directory },
      ],
      inheritStderr: false,
      noOverlay: true,
    });
    const connection = await context.host.start();
    context.connection = connection;
    context.exit = context.host
      .waitForExit(connection.generation)
      .then((exit) => {
        if (exit.generation !== connection.generation)
          throw new Error("CUA exit generation mismatch");
        if (!context.retired) this.fail(context, "cua_unexpected_exit");
        return exit;
      });
    void context.exit.catch(() =>
      this.fail(context, "cua_exit_observer_failed"),
    );
    this.assertCurrent(context);
    context.client = sdk.connect(connection.socketPath);
    const metadata = await context.client.metadata({
      signal: context.abort.signal,
    });
    this.validateMetadata(context, connection, metadata);
    this.assertCurrent(context);
    this.phase = "ready";
    return { generation: context.id, driverVersion: metadata.driverVersion };
  }

  private validateMetadata(
    context: Generation,
    connection: EmbeddedDriverConnection,
    metadata: DriverMetadata,
  ): void {
    if (
      connection.driverVersion !== artifacts.driverVersion ||
      metadata.driverVersion !== artifacts.driverVersion ||
      metadata.pid !== connection.pid ||
      !metadata.embedded ||
      metadata.hostBundleId !== this.options.hostBundleId ||
      metadata.contractVersion !== connection.contractVersion ||
      metadata.mcpProtocolVersion !== connection.mcpProtocolVersion ||
      context.directory === null ||
      connection.socketPath !== path.join(context.directory, "driver.sock")
    )
      throw new Error("CUA exact version or embedded metadata mismatch");
  }

  private fail(context: Generation, error: string): void {
    if (this.context !== context) return;
    this.error ??= error;
    this.phase = "error";
    void this.retire(context).catch(() => {
      // A rejected stop/observer cannot release ownership or allow replacement.
      if (this.context === context) this.error = "cua_cleanup_unproven";
    });
  }

  private retire(context: Generation): Promise<void> {
    context.retired = true;
    context.abort.abort();
    context.retirement ??= this.cleanup(context);
    return context.retirement;
  }

  private async cleanup(context: Generation): Promise<void> {
    // Cancel a native start immediately, while retaining its late result. Once
    // connected, settle pending metadata before destroying its client.
    const earlyStop =
      context.host && !context.connection
        ? context.host.stop()
        : Promise.resolve();
    const results = await Promise.allSettled([
      context.initialization,
      earlyStop,
    ]);
    if (results[1]?.status === "rejected")
      throw new Error("CUA startup cancellation is unproven");
    if (context.probe) await context.probe.catch(() => {});
    context.client?.uniffiDestroy();
    context.client = null;
    if (context.host) {
      await context.host.stop();
      if (context.exit) await context.exit;
      if (context.host.state() !== context.sdk?.stoppedState)
        throw new Error("CUA process exit is unproven");
      context.host.uniffiDestroy();
    }
    if (context.directory)
      await rm(context.directory, { recursive: true, force: true });
    if (this.context === context) {
      this.context = null;
      this.phase = this.error ? "error" : "stopped";
    }
  }

  async stop(): Promise<void> {
    const context = this.context;
    if (!context) return;
    this.phase = "retiring";
    try {
      await withComputerUseDeadline(
        this.retire(context),
        this.options.deadlineMs ?? 5_000,
      );
    } catch {
      if (this.context === context) {
        this.phase = "error";
        this.error = "cua_cleanup_unproven";
      }
      throw new Error("CUA cleanup is unproven; replacement remains blocked");
    }
  }

  dispose(): Promise<void> {
    this.closed = true;
    return this.stop();
  }

  /** Fixed host-only verification surface; never forwarded to IPC or agents. */
  probe(capture: boolean): Promise<CuaProbeResult> {
    const context = this.context;
    if (!context || this.phase !== "ready" || context.retired)
      return Promise.reject(new Error("CUA probe requires a ready generation"));
    context.probe ??= this.inspect(context, capture);
    return withComputerUseDeadline(
      context.probe,
      this.options.deadlineMs ?? 15_000,
    ).catch(() => {
      this.fail(context, "cua_probe_failed");
      throw new Error("CUA host probe failed");
    });
  }

  private async inspect(
    context: Generation,
    capture: boolean,
  ): Promise<CuaProbeResult> {
    const client = context.client;
    if (!client) throw new Error("CUA client is unavailable");
    const asyncOptions = { signal: context.abort.signal };
    const result = await client.callTool(
      "check_permissions",
      '{"prompt":false,"probe_direct_capture":false}',
      asyncOptions,
    );
    if (result.isError || !result.structuredJson)
      throw new Error("CUA permission probe failed");
    const data: unknown = JSON.parse(result.structuredJson);
    if (
      !data ||
      typeof data !== "object" ||
      !("accessibility" in data) ||
      typeof data.accessibility !== "boolean" ||
      !("screen_recording" in data) ||
      typeof data.screen_recording !== "boolean" ||
      !("source" in data) ||
      !data.source ||
      typeof data.source !== "object" ||
      !("attribution" in data.source) ||
      data.source.attribution !== "host"
    )
      throw new Error("CUA permission attribution is incompatible");
    this.assertCurrent(context);
    let screenshot: string | null = null;
    if (capture && data.accessibility && data.screen_recording) {
      const session = `okou-host-probe-${context.id}`;
      // Own even a late/failed session creation until its explicit end settles.
      try {
        await client.startSession({ session }, asyncOptions);
        this.assertCurrent(context);
        const image = await client.getDesktopState({ session }, asyncOptions);
        this.assertCurrent(context);
        const png = image.images.find((item) => item.mimeType === "image/png");
        if (image.isError || !png) throw new Error("CUA screenshot failed");
        screenshot = png.dataBase64;
      } finally {
        await client.endSession({ session });
      }
    }
    this.assertCurrent(context);
    return {
      accessibility: data.accessibility,
      screenRecording: data.screen_recording,
      attribution: "host",
      screenshot,
    };
  }
}
