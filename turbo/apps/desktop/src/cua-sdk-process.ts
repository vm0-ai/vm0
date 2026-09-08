import type { EmbeddedDriverConnection } from "@trycua/cua-driver";
import { connect } from "node:net";
import path from "node:path";
import {
  CUA_MAX_PENDING,
  CUA_REPLY_BYTES,
  CUA_REQUEST_BYTES,
  cuaCancelSchema,
  cuaMonotonicMs,
  cuaRequestSchema,
  readCuaFrames,
  type CuaOperation,
} from "./cua-process-protocol";
import { loadPackagedCuaSdk, type CuaSdk } from "./cua-runtime-files";

const [root, directory, bundleId, generationText] = process.argv.slice(-4);
if (
  !root ||
  !directory ||
  !bundleId ||
  !generationText ||
  !path.isAbsolute(root) ||
  !directory.startsWith("/tmp/okou-cua-")
)
  throw new Error("Invalid fixed CUA process configuration");
if (!/^[1-9][0-9]*(?::block-cleanup)?$/.test(generationText))
  throw new Error("Invalid fixed CUA process mode");
const blockCleanup = generationText.endsWith(":block-cleanup");
const generation = Number(generationText.split(":")[0]);
if (!Number.isSafeInteger(generation) || generation <= 0)
  throw new Error("Invalid CUA generation");
const socket = connect(path.join(directory, "rpc.sock"));
const requests = new Map<number, AbortController>();
const sessions = new Set<string>();
let lastId = 0;
let retiring = false;
let sdk: CuaSdk | null = null;
let host: ReturnType<CuaSdk["createHost"]> | null = null;
let client: ReturnType<CuaSdk["connect"]> | null = null;
let connection: EmbeddedDriverConnection | null = null;
const die = () => process.exit(1);
socket.on("error", die);
socket.on("close", die);

async function execute(
  operation: CuaOperation,
  signal: AbortSignal,
): Promise<unknown> {
  if (operation.method === "start") {
    if (sdk || retiring) throw new Error("CUA host already owned");
    sdk = await loadPackagedCuaSdk(root!);
    if (retiring || signal.aborted) throw new Error("CUA startup retired");
    host = sdk.createHost({
      binaryPath: path.join(root!, "cua-driver"),
      socketPath: path.join(directory!, "driver.sock"),
      hostBundleId: bundleId!,
      startupTimeoutMs: 10_000n,
      shutdownTimeoutMs: 2_000n,
      permissionMode: sdk.standardPermissionMode,
      approveCapabilityManifest: false,
      approveSessionPolicy: false,
      dangerouslyBypassApprovals: false,
      environment: [
        { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "0" },
        { name: "CUA_TELEMETRY_ENABLED", value: "0" },
        { name: "HOME", value: directory! },
      ],
      inheritStderr: false,
      noOverlay: true,
    });
    connection = await host.start();
    // The adapter does not consume the SDK MCP launcher configuration.
    return { ...connection, mcp: { command: "", args: [], environment: [] } };
  }
  if (operation.method === "stop") {
    retiring = true;
    // Dedicated package probe only: block actual helper execution before native cleanup.
    if (blockCleanup)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    await host?.stop();
    return host?.state() ?? 0;
  }
  if (operation.method === "exit") {
    if (!host || operation.input.generation !== connection?.generation)
      throw new Error("CUA exit generation mismatch");
    return host.waitForExit(operation.input.generation);
  }
  if (operation.method === "destroyHost") {
    host?.uniffiDestroy();
    host = null;
    return null;
  }
  if (operation.method === "destroyClient") {
    client?.uniffiDestroy();
    client = null;
    return null;
  }
  if (operation.method === "finish") {
    if (host || client || requests.size !== 1)
      throw new Error("CUA objects remain owned");
    return null;
  }
  if (!sdk || !connection || (retiring && operation.method !== "sessionEnd"))
    throw new Error("CUA client is unavailable");
  client ??= sdk.connect(connection.socketPath);
  if (operation.method === "metadata") return client.metadata({ signal });
  if (operation.method === "tool") {
    const { name, args } = operation.input;
    if ("session" in args && !sessions.has(args.session))
      throw new Error("Foreign CUA session");
    const result = await client.callTool(name, JSON.stringify(args), {
      signal,
    });
    // Only fields consumed by the fixed adapter cross this boundary.
    return {
      text: result.text,
      images: result.images,
      structuredJson: result.structuredJson,
      isError: result.isError,
      degraded: result.degraded,
      rawJson: result.rawJson,
      errorCode: result.errorCode,
    };
  }
  const { session } = operation.input;
  if (operation.method === "sessionStart") {
    sessions.add(session);
    return client.startSession({ session }, { signal });
  }
  if (!sessions.has(session)) throw new Error("Foreign CUA session");
  if (operation.method === "sessionEnd") {
    const result = await client.endSession({ session }, { signal });
    sessions.delete(session);
    return result;
  }
  return client.getDesktopState({ session }, { signal });
}

readCuaFrames(
  socket,
  CUA_REQUEST_BYTES,
  (value) => {
    const cancel = cuaCancelSchema.safeParse(value);
    if (cancel.success) {
      if (cancel.data.generation !== generation) {
        die();
        return;
      }
      requests.get(cancel.data.cancel)?.abort();
      return;
    }
    const request = cuaRequestSchema.parse(value);
    if (
      request.generation !== generation ||
      request.id <= lastId ||
      requests.size >= CUA_MAX_PENDING
    )
      throw new Error("CUA RPC ownership or capacity violation");
    lastId = request.id;
    const remaining = request.expiresAt - cuaMonotonicMs();
    const abort = new AbortController();
    requests.set(request.id, abort);
    const timer = setTimeout(() => abort.abort(), Math.max(0, remaining));
    const work =
      remaining > 0 && remaining <= 120_100
        ? execute(request.operation, abort.signal)
        : Promise.reject(new Error("CUA request expired before execution"));
    void work.then(
      (result) => send(true, result),
      () => send(false, null),
    );
    function send(ok: boolean, result: unknown): void {
      clearTimeout(timer);
      requests.delete(request.id);
      const response = ok
        ? { generation, id: request.id, ok: true, value: result }
        : {
            generation,
            id: request.id,
            ok: false,
            error: "cua_operation_failed",
          };
      const frame = JSON.stringify(response) + "\n";
      if (
        Buffer.byteLength(frame) > CUA_REPLY_BYTES ||
        socket.writableLength > CUA_REPLY_BYTES
      ) {
        die();
        return;
      }
      if (ok && request.operation.method === "finish") {
        socket.removeListener("close", die);
        socket.end(frame, () => process.exit(0));
      } else socket.write(frame);
    }
  },
  die,
);
