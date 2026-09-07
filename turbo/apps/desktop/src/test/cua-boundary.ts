import type {
  DriverMetadata,
  EmbeddedDriverConnection,
  EmbeddedDriverExit,
  ToolResult,
} from "@trycua/cua-driver";
import type { CuaSdk } from "../cua-runtime-files";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function toolResult(
  data: Record<string, unknown>,
  images: ToolResult["images"] = [],
): ToolResult {
  return {
    text: "",
    images,
    isError: false,
    degraded: false,
    rawJson: "{}",
    structuredJson: JSON.stringify(data),
  };
}

/** Only the public SDK/daemon boundary is substituted; all ownership code is real. */
export function cuaBoundary() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const exit = deferred<EmbeddedDriverExit>();
  const stopEntered = deferred<void>();
  let connection: EmbeddedDriverConnection;
  let state = 0;
  let snapshot = 0;
  let destroyed = false;
  let sessions = 0;
  let live = false;
  let granted = true;
  let pid = 123;
  let windowId = 42;
  let bounds = { x: 10, y: 20, width: 800, height: 600 };
  let scale = 2;
  let resize = 1;
  let observationFields: Record<string, unknown> = {};
  let effect: Record<string, unknown> = {
    effect: "unverifiable",
    route: "synthetic_events",
    delivery: { mode: "background" },
  };
  let intercept: (name: string) => Promise<void> = async () => {};
  const sdk: CuaSdk = {
    standardPermissionMode: 0,
    stoppedState: 0,
    createHost(options) {
      connection = {
        socketPath: options.socketPath!,
        generation: "embedded-1",
        pid: 987,
        driverVersion: "0.23.2",
        contractVersion: "contract",
        mcpProtocolVersion: "mcp",
        mcp: { command: options.binaryPath, args: [], environment: [] },
      };
      return {
        async start() {
          live = true;
          state = 2;
          return connection;
        },
        async stop() {
          stopEntered.resolve();
          await intercept("stop");
          live = false;
          state = 0;
          exit.resolve({
            generation: connection.generation,
            code: 0,
            success: true,
          });
        },
        waitForExit: () => exit.promise,
        state: () => state,
        uniffiDestroy() {},
      };
    },
    connect() {
      return {
        async metadata(): Promise<DriverMetadata> {
          return {
            ...connection,
            embedded: true,
            hostBundleId: "ai.okou.desktop",
            toolsListSchemaVersion: "tools",
            capabilityVersion: "capabilities",
          };
        },
        async startSession({ session }) {
          await intercept("session");
          sessions++;
          return {
            active: true,
            revived: false,
            state: {
              session: session!,
              captureScope: 0,
              effectiveScope: 1,
              desktopCaptureAuthorized: true,
              desktopUnlocked: true,
            },
          };
        },
        async endSession({ session }) {
          await intercept("end");
          return { session: session!, active: false };
        },
        async getDesktopState() {
          throw new Error("Unexpected full desktop capture");
        },
        uniffiDestroy() {
          destroyed = true;
        },
        async callTool(name, json) {
          const args: Record<string, unknown> = JSON.parse(json);
          calls.push({ name, args });
          await intercept(name);
          if (name === "check_permissions")
            return toolResult({
              accessibility: granted,
              screen_recording: granted,
              source: { attribution: "host" },
            });
          if (name === "list_apps")
            return toolResult({
              apps: [
                {
                  name: "Editor",
                  bundle_id: "test.editor",
                  launch_path: "/Applications/Editor.app",
                  running: true,
                  pid,
                },
                {
                  name: "Installed",
                  bundle_id: "test.installed",
                  launch_path: "/Applications/Installed.app",
                  running: false,
                  pid: 0,
                },
                {
                  name: "Unknown",
                  bundle_id: null,
                  launch_path: null,
                  running: true,
                  pid: 777,
                },
              ],
            });
          if (name === "list_windows")
            return toolResult({
              windows: [
                { pid, window_id: windowId, title: "Document", bounds },
              ],
            });
          if (name === "launch_app")
            return toolResult({
              pid,
              bundle_id: args.bundle_id,
              name: "Editor",
              windows: [
                { pid, window_id: windowId, title: "Document", bounds },
              ],
              launch_state: {
                requested: true,
                process_running: true,
                window_ready: true,
              },
            });
          if (name === "get_window_state") {
            const width = Math.round(bounds.width * scale * resize);
            const height = Math.round(bounds.height * scale * resize);
            const png = Buffer.alloc(24);
            png.write("89504e470d0a1a0a", "hex");
            png.writeUInt32BE(width, 16);
            png.writeUInt32BE(height, 20);
            snapshot++;
            return toolResult(
              {
                pid,
                window_id: windowId,
                snapshot_id: `opaque-${snapshot}`,
                screenshot_frame_valid: true,
                screenshot_mime_type: "image/png",
                screenshot_width: width,
                screenshot_height: height,
                screenshot_scale: scale,
                window_bounds: bounds,
                tree_markdown:
                  "Read-only invoice total: 123 元\n[0] Text field\n[1] Save",
                elements_complete: false,
                elements: [
                  {
                    element_index: 0,
                    element_token: `opaque-field-${snapshot}`,
                    role: "AXTextField",
                    label: "Text field",
                    value: "内容",
                  },
                  {
                    element_index: 1,
                    element_token: `opaque-button-${snapshot}`,
                    role: "AXButton",
                    label: "Save",
                  },
                ],
                ...observationFields,
              },
              [{ mimeType: "image/png", dataBase64: png.toString("base64") }],
            );
          }
          return toolResult(effect);
        },
      };
    },
  };
  return {
    sdk,
    calls,
    stopEntered,
    exited: exit.promise,
    set intercept(value: typeof intercept) {
      intercept = value;
    },
    set effect(value: Record<string, unknown>) {
      effect = value;
    },
    set granted(value: boolean) {
      granted = value;
    },
    set pid(value: number) {
      pid = value;
    },
    set windowId(value: number) {
      windowId = value;
    },
    set bounds(value: typeof bounds) {
      bounds = value;
    },
    set scale(value: number) {
      scale = value;
    },
    set resize(value: number) {
      resize = value;
    },
    set observation(value: Record<string, unknown>) {
      observationFields = value;
    },
    get destroyed() {
      return destroyed;
    },
    get sessions() {
      return sessions;
    },
    get live() {
      return live;
    },
    crash() {
      state = 0;
      live = false;
      exit.resolve({
        generation: connection.generation,
        code: 1,
        success: false,
      });
    },
  };
}
