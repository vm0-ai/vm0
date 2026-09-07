import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import artifacts from "../cua/artifacts.json";
import type {
  CuaDriver,
  EmbeddedCuaDriverHost,
  EmbeddedDriverHostOptions,
  EmbeddedDriverHostState,
  EmbeddedPermissionMode,
} from "@trycua/cua-driver";

export interface CuaSdk {
  readonly standardPermissionMode: EmbeddedPermissionMode;
  readonly stoppedState: EmbeddedDriverHostState;
  createHost(
    options: EmbeddedDriverHostOptions,
  ): Pick<
    EmbeddedCuaDriverHost,
    "start" | "stop" | "state" | "waitForExit" | "uniffiDestroy"
  >;
  connect(
    socket: string,
  ): Pick<
    CuaDriver,
    | "metadata"
    | "callTool"
    | "startSession"
    | "endSession"
    | "getDesktopState"
    | "uniffiDestroy"
  >;
}

let sdkLoadAttempted = false;

export function assertCuaDormant(): void {
  if (sdkLoadAttempted)
    throw new Error("Default Desktop startup attempted to load CUA");
}

/** Only called by explicit host start, never while importing Desktop modules. */
export async function loadPackagedCuaSdk(runtimeRoot: string) {
  sdkLoadAttempted = true;
  const root = await realpath(runtimeRoot);
  const payload: unknown = JSON.parse(
    await readFile(path.join(root, "payload.json"), "utf8"),
  );
  if (
    !payload ||
    typeof payload !== "object" ||
    !("driverVersion" in payload) ||
    payload.driverVersion !== artifacts.driverVersion ||
    !("files" in payload) ||
    !payload.files ||
    typeof payload.files !== "object"
  )
    throw new Error("CUA payload manifest is incompatible");

  const expectedFiles = artifacts.artifacts.flatMap((artifact) =>
    artifact.files.map((file) =>
      path.join(
        artifact.destination,
        artifact.destination === "." ? file : file.slice("package/".length),
      ),
    ),
  );
  for (const file of expectedFiles) {
    const absolute = path.join(root, file);
    if (
      !(await lstat(absolute)).isFile() ||
      (await realpath(absolute)) !== absolute
    )
      throw new Error("CUA payload contains an external or non-file resource");
    // Upstream hashes describe pre-sign bytes. Native code is validated by the
    // app signature/macOS loader after signing, then by the live SDK handshake.
    if (artifacts.nativeCode.includes(file)) continue;
    const expected: unknown = Reflect.get(payload.files, file);
    const actual = createHash("sha256")
      .update(await readFile(absolute))
      .digest("hex");
    if (actual !== expected) throw new Error("CUA payload integrity mismatch");
  }

  process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "0";
  process.env.CUA_TELEMETRY_ENABLED = "0";
  // Keep import() native in the CJS main bundle: CUA is ESM and resolves its
  // own .node/dylib through package-relative paths outside root node_modules.
  const sdk: typeof import("@trycua/cua-driver") = await import(
    pathToFileURL(
      path.join(root, "node_modules/@trycua/cua-driver/dist/index.js"),
    ).href
  );
  return {
    standardPermissionMode: sdk.EmbeddedPermissionMode.Standard,
    stoppedState: sdk.EmbeddedDriverHostState.Stopped,
    createHost(options) {
      const host = sdk.EmbeddedCuaDriverHost.withOptions(options);
      if (!sdk.EmbeddedCuaDriverHost.instanceOf(host))
        throw new Error("Invalid CUA host object");
      return host;
    },
    connect(socket) {
      const client = sdk.CuaDriver.connect(socket);
      if (!sdk.CuaDriver.instanceOf(client))
        throw new Error("Invalid CUA client object");
      return client;
    },
  } satisfies CuaSdk;
}
