import { randomUUID } from "node:crypto";
import type { ToolResult } from "@trycua/cua-driver";
import { CuaEmbeddedRuntime } from "./cua-runtime";
import { withComputerUseDeadline } from "./computer-use-lifecycle-deadline";
import type { ComputerUseCommandBudget } from "./computer-use-command-budget";
import type { ComputerUseDriver } from "./computer-use-driver";
import {
  ComputerUseNativeHelperError,
  type ComputerUseNativeBackend,
  type ComputerUseNativeForegroundRecoveryPolicy,
} from "./computer-use-native";
import type {
  AccessibilityAppStateSnapshot,
  AccessibilityElementSnapshot,
  ComputerUseCommand,
  ComputerUseCoordinateBounds,
} from "./computer-use-accessibility";
import {
  actionFacts,
  arrayField,
  boundsField,
  integer,
  normalizeKey,
  readResult,
  record,
  refuse,
  structured,
  textField,
} from "./cua-adapter-contract";

const DISCOVERY_NOTE =
  "CUA 0.23.2 uses a private child home to keep standalone history opt-in isolated. Running apps and system application directories are enumerated; the real user's ~/Applications is outside installed-app discovery.";
type Tool =
  | "list_apps"
  | "launch_app"
  | "list_windows"
  | "get_window_state"
  | "click"
  | "set_value"
  | "type_text"
  | "press_key"
  | "scroll";
type ElementRequest = {
  readonly app: string;
  readonly elementId?: string;
  readonly snapshotId?: string;
};
interface App {
  readonly name: string;
  readonly bundleId?: string;
  readonly appPath?: string;
  readonly running: boolean;
  readonly pid: number;
}
interface Window {
  readonly pid: number;
  readonly windowId: number;
  readonly title: string;
  readonly bounds: ComputerUseCoordinateBounds;
}
interface Observation {
  readonly app: App;
  readonly window: Window;
  readonly snapshotId: string;
  readonly cuaSnapshot: string | null;
  readonly tokens: ReadonlyMap<string, string>;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/** Lazy internal factory; the Desktop lifecycle owns opt-in and admission. */
export function createCuaComputerUseDriver(
  options: ConstructorParameters<typeof CuaEmbeddedRuntime>[0],
): ComputerUseDriver {
  return {
    id: "cua",
    createBackend: () =>
      new CuaComputerUseBackend(new CuaEmbeddedRuntime(options)),
  };
}

class CuaComputerUseBackend implements ComputerUseNativeBackend {
  isCleanupPending = () => this.runtime.getState().cleanupPending;
  getRuntimeVersion = () => this.runtime.getState().loadedDriverVersion;
  readonly supportsWindowScroll = true;
  readonly discoveryNote = DISCOVERY_NOTE;
  private observation: Observation | null = null;
  private retired = false;
  private granted = false;
  private budget: ComputerUseCommandBudget | null = null;
  setCommandBudget = (budget: ComputerUseCommandBudget | null) => {
    this.budget = budget;
    this.runtime.setCommandBudget(budget);
  };
  constructor(private readonly runtime: CuaEmbeddedRuntime) {}

  isAvailable = () =>
    !this.retired && this.granted && this.runtime.getState().phase === "ready";
  forceStop = (): Promise<void> => {
    this.retired = true;
    this.granted = false;
    this.observation = null;
    return this.runtime.dispose();
  };
  dispose = (): Promise<void> => this.forceStop();

  private assertLive(): void {
    if (this.budget && this.budget.remaining() <= 0) {
      void this.forceStop().catch(() => {});
      throw new ComputerUseNativeHelperError(
        "command_timeout",
        "CUA total command budget expired; completion may be unknown, do not replay",
      );
    }
    if (!this.isAvailable())
      throw new ComputerUseNativeHelperError(
        "accessibility_unavailable",
        "CUA generation is unavailable; explicit recovery is required",
      );
  }

  getPermissions = async () => {
    if (this.retired) return { accessibility: false, screenRecording: false };
    await this.runtime.start();
    const result = await withComputerUseDeadline(
      this.runtime.useClient((client, signal) =>
        client.callTool(
          "check_permissions",
          '{"prompt":false,"probe_direct_capture":false}',
          { signal },
        ),
      ),
      Math.min(5000, this.budget?.remaining() ?? 5000),
    ).catch((error: unknown) => {
      void this.forceStop().catch(() => {});
      throw error;
    });
    const data = readResult(result);
    if (
      typeof data.accessibility !== "boolean" ||
      typeof data.screen_recording !== "boolean" ||
      record(data.source).attribution !== "host"
    )
      throw new ComputerUseNativeHelperError(
        "permission_denied",
        "CUA permission attribution is incompatible",
      );
    const permissions = {
      accessibility: data.accessibility,
      screenRecording: data.screen_recording,
    };
    const revoked =
      this.granted &&
      !(permissions.accessibility && permissions.screenRecording);
    this.granted = permissions.accessibility && permissions.screenRecording;
    if (revoked) void this.forceStop().catch(() => {}); // Runtime retains failed cleanup ownership.
    return permissions;
  };
  requestAccessibilityPermission = () => this.getPermissions();
  requestScreenRecordingPermission = () => this.getPermissions();
  probeAutomationPermission = async () => ({
    status: "unknown" as const,
    updatedAt: null,
    reason: "CUA does not use the Okou browser Apple Events helper",
  });

  validateCommand = (command: ComputerUseCommand): void => {
    this.assertLive();
    const p = command.payload;
    if (
      (p.snapshotId !== undefined &&
        this.observation?.snapshotId !== p.snapshotId) ||
      (p.elementIndex !== undefined && p.snapshotId === undefined)
    )
      refuse("CUA index targeting requires the current snapshotId; re-observe");
    if (
      command.kind !== "apps.list" &&
      (typeof p.app !== "string" ||
        p.app.length > 256 ||
        !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(p.app))
    )
      refuse("CUA requires an exact application bundle ID");
    if (command.kind === "element.click") {
      const count = p.clickCount ?? 1;
      const button = p.button ?? "left";
      if (
        ![1, 2].includes(Number(count)) ||
        typeof count !== "number" ||
        !["left", "right", "middle"].includes(String(button))
      )
        refuse(
          "CUA supports single/double coordinate clicks and single left AX clicks",
        );
      if (
        (p.elementId !== undefined || p.elementIndex !== undefined) &&
        (count !== 1 || button !== "left")
      )
        refuse(
          "CUA AX click requires one left click; observe and use coordinates for other clicks",
        );
      if (p.x !== undefined || p.y !== undefined) {
        if (!this.observation || p.snapshotId !== this.observation.snapshotId)
          refuse(
            "CUA coordinates require the retained snapshotId; re-observe the window",
          );
      }
    }
    if (
      command.kind === "element.scroll" &&
      (p.elementId !== undefined ||
        p.elementIndex !== undefined ||
        !["up", "down"].includes(String(p.direction)) ||
        !Number.isInteger(p.pages ?? 1) ||
        Number(p.pages ?? 1) < 1 ||
        Number(p.pages ?? 1) > 25)
    )
      refuse(
        "CUA supports 1-25 whole vertical pages of the focused window only; targeted/fractional scroll is unsupported",
      );
    for (const key of ["text", "value"] as const) {
      if (
        p[key] !== undefined &&
        (typeof p[key] !== "string" ||
          p[key].length === 0 ||
          p[key].length > 64_000)
      )
        refuse("CUA text/value must contain 1-64000 characters");
    }
    if (
      typeof p.text === "string" &&
      /<\/(?:text|parameter|invoke|function_calls|function_call|tool_use|tool_call|antml:parameter|antml:invoke|antml:function_calls)>\s*$/i.test(
        p.text,
      )
    )
      refuse(
        "CUA may strip trailing protocol tags; this text shape is unsupported",
      );
  };

  private async tool(
    name: Tool,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    this.assertLive();
    try {
      const session = await this.runtime.ensureSession();
      this.assertLive();
      return await this.runtime.useClient((client, signal) =>
        client.callTool(
          name,
          JSON.stringify({
            ...args,
            ...(["list_apps", "launch_app", "list_windows"].includes(name)
              ? {}
              : { session }),
          }),
          { signal },
        ),
      );
    } catch {
      void this.forceStop().catch(() => {});
      throw new ComputerUseNativeHelperError(
        "accessibility_unavailable",
        "CUA transport failed; action completion may be unknown, do not replay; generation retirement remains owned",
      );
    }
  }

  listApps = async (): Promise<App[]> => {
    const data = readResult(await this.tool("list_apps", {}));
    return arrayField(data.apps, 10_000).map((item) => {
      const app = record(item);
      if (typeof app.running !== "boolean")
        refuse("CUA app running state is invalid");
      const pid = integer(app.pid);
      if (app.running && pid === 0) refuse("CUA running app has no live PID");
      return {
        name: textField(app.name),
        ...(app.bundle_id !== null
          ? { bundleId: textField(app.bundle_id) }
          : {}),
        ...(app.launch_path !== null
          ? { appPath: textField(app.launch_path) }
          : {}),
        running: app.running,
        pid,
      };
    });
  };

  private async resolveApp(bundleId: string): Promise<App> {
    const matches = (await this.listApps()).filter(
      (app) => app.bundleId === bundleId && app.running && app.pid > 0,
    );
    if (matches.length !== 1) {
      this.observation = null;
      throw new ComputerUseNativeHelperError(
        "app_not_found",
        "CUA requires one live process for the exact bundle ID; open/re-observe the intended application",
      );
    }
    return matches[0]!;
  }

  private async resolveWindow(app: App, retained?: Window): Promise<Window> {
    const data = readResult(
      await this.tool("list_windows", { pid: app.pid, on_screen_only: false }),
    );
    const windows = arrayField(data.windows, 1000)
      .map((item) => {
        const window = record(item);
        return {
          pid: integer(window.pid, 1),
          windowId: integer(window.window_id, 1),
          title: textField(window.title),
          bounds: boundsField(window.bounds),
        };
      })
      .filter((window) => window.pid === app.pid);
    const matches = retained
      ? windows.filter((window) => window.windowId === retained.windowId)
      : windows;
    if (matches.length !== 1) {
      this.observation = null;
      throw new ComputerUseNativeHelperError(
        "window_unavailable",
        "CUA window target is missing or ambiguous; close extra windows and re-observe",
      );
    }
    return matches[0]!;
  }

  private async retained(args: ElementRequest): Promise<Observation> {
    const observed = this.observation;
    if (
      !observed ||
      observed.app.bundleId !== args.app ||
      (args.snapshotId !== undefined &&
        observed.snapshotId !== args.snapshotId) ||
      (args.elementId !== undefined && !observed.tokens.has(args.elementId))
    )
      refuse(
        "Stale CUA target; run app.state again and use its new snapshot/index",
      );
    const app = await this.resolveApp(args.app);
    if (app.pid !== observed.app.pid || app.appPath !== observed.app.appPath) {
      this.observation = null;
      refuse("CUA process ownership changed; re-observe");
    }
    const window = await this.resolveWindow(app, observed.window);
    if (
      JSON.stringify(window.bounds) !== JSON.stringify(observed.window.bounds)
    ) {
      this.observation = null;
      refuse("CUA window moved or resized; re-observe before acting");
    }
    this.assertLive();
    if (this.observation !== observed)
      refuse("CUA observation was superseded; re-observe");
    return observed;
  }

  private readFrame(
    result: ToolResult,
    data: Record<string, unknown>,
    window: Window,
  ) {
    const bounds = boundsField(data.window_bounds);
    const width = integer(data.screenshot_width, 1);
    const height = integer(data.screenshot_height, 1);
    const scale = data.screenshot_scale;
    if (
      (scale !== 1 && scale !== 2) ||
      Math.abs(height - (width * bounds.height) / bounds.width) > 1 ||
      width > bounds.width * scale + 1 ||
      height > bounds.height * scale + 1 ||
      JSON.stringify(bounds) !== JSON.stringify(window.bounds)
    )
      refuse("CUA screenshot geometry is inconsistent; re-observe");
    const png = result.images.length === 1 ? result.images[0] : undefined;
    if (
      !png ||
      png.mimeType !== "image/png" ||
      png.dataBase64.length > 8_000_000
    )
      throw new ComputerUseNativeHelperError(
        "screen_recording_unavailable",
        "CUA did not return one bounded window PNG",
      );
    const bytes = Buffer.from(png.dataBase64, "base64");
    if (
      bytes.length < 24 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(16) !== width ||
      bytes.readUInt32BE(20) !== height
    )
      refuse("CUA PNG dimensions do not match the retained frame");
    return { bounds, width, height, scale, png };
  }

  private readElements(data: Record<string, unknown>) {
    const tokens = new Map<string, string>();
    const ids: string[] = [];
    const elements: AccessibilityElementSnapshot[] = arrayField(
      data.elements,
      1200,
    ).map((item) => {
      const e = record(item);
      const index = integer(e.element_index);
      if (index >= 1200 || ids[index] !== undefined)
        refuse("CUA element indexes are invalid");
      const id = `cua-${randomUUID()}`;
      const token = textField(e.element_token, 512);
      if (!token) refuse("CUA actionable element has no token");
      tokens.set(id, token);
      ids[index] = id;
      return {
        id,
        index,
        role: textField(e.role),
        ...(e.label !== undefined ? { name: textField(e.label) } : {}),
        ...(e.value !== undefined ? { value: textField(e.value) } : {}),
      };
    });
    const cuaSnapshot =
      data.snapshot_id === undefined ? null : textField(data.snapshot_id, 512);
    if (tokens.size > 0 && !cuaSnapshot)
      refuse("CUA actionable elements have no snapshot owner");
    return { tokens, ids, elements, cuaSnapshot };
  }

  getAppState = async (
    bundleId: string,
    snapshotId: string,
  ): Promise<AccessibilityAppStateSnapshot> => {
    const previous = this.observation;
    this.observation = null; // Even a failed refresh invalidates the previous token registry.
    const app = await this.resolveApp(bundleId);
    const window = await this.resolveWindow(
      app,
      previous?.app.bundleId === bundleId && previous.app.pid === app.pid
        ? previous.window
        : undefined,
    );
    const result = await this.tool("get_window_state", {
      pid: app.pid,
      window_id: window.windowId,
      include_screenshot: true,
      max_elements: 1200,
      max_depth: 32,
    });
    const data = readResult(result);
    if (
      data.pid !== app.pid ||
      data.window_id !== window.windowId ||
      data.screenshot_frame_valid !== true ||
      data.screenshot_mime_type !== "image/png"
    )
      throw new ComputerUseNativeHelperError(
        "window_unavailable",
        "CUA observation has an invalid owner or screenshot frame",
      );
    const { bounds, width, height, scale, png } = this.readFrame(
      result,
      data,
      window,
    );
    const { tokens, ids, elements, cuaSnapshot } = this.readElements(data);
    this.assertLive();
    this.observation = {
      app,
      window,
      snapshotId,
      cuaSnapshot,
      tokens,
      width,
      height,
      scale,
    };
    return {
      app: bundleId,
      bundleId,
      appDisplayName: app.name,
      appPath: app.appPath,
      pid: app.pid,
      windowId: window.windowId,
      windowTitle: window.title,
      windowFrame: bounds,
      snapshotId,
      elements,
      elementIdsByIndex: ids,
      observation: {
        source: "cua",
        text: textField(data.tree_markdown),
        elementsComplete: false,
      },
      truncated: true,
      truncationReasons: [
        "CUA structured elements cover actionable nodes only; absence is not authoritative",
        ...(data.degraded_reason !== undefined
          ? [textField(data.degraded_reason)]
          : []),
      ],
      screenshot: `data:image/png;base64,${png.dataBase64}`,
      screenshotMimeType: "image/png",
      screenshotSource: "window",
      screenshotSourceName: window.title || app.name,
      screenshotWidth: width,
      screenshotHeight: height,
      screenshotSourceBounds: bounds,
    };
  };

  openApp = async (app: string) => {
    this.observation = null;
    const data = readResult(await this.tool("launch_app", { bundle_id: app }));
    if (data.bundle_id !== app)
      refuse("CUA launch returned a different application");
    integer(data.pid, 1);
    textField(data.name);
    arrayField(data.windows, 1000);
    const launchState = record(data.launch_state);
    if (
      typeof launchState.requested !== "boolean" ||
      launchState.process_running !== true ||
      typeof launchState.window_ready !== "boolean"
    )
      refuse("CUA launch has no proven running process");
    const launched = await this.resolveApp(app);
    if (launched.pid !== data.pid)
      refuse("CUA launch process ownership changed");
    return { driver: "cua", driverVersion: "0.23.2", launch: data };
  };

  private delivery(
    policy: ComputerUseNativeForegroundRecoveryPolicy | undefined,
  ): string {
    // on-window-unavailable permits recovery, but does not require it. A refusal
    // stays a refusal; advice never authorizes replay or implicit escalation.
    return policy === "always" ? "foreground" : "background";
  }

  private async action(name: Tool, args: Record<string, unknown>) {
    const result = await this.tool(name, args);
    // Any attempted action consumes the retained addressing, including malformed
    // or uncertain replies. Only an explicit post-state can establish new targets.
    this.observation = null;
    const data = structured(result);
    if (
      result.isError &&
      (data.effect === undefined || data.route === undefined)
    ) {
      const message = result.text.slice(0, 1000);
      this.observation = null;
      throw new ComputerUseNativeHelperError(
        "element_action_unsupported",
        `CUA action refused or completion unknown: ${message}; evidence=${JSON.stringify(data).slice(0, 2000)}; do not replay without re-observation`,
      );
    }
    const facts = actionFacts(result);
    if (facts.effect === "refused")
      throw new ComputerUseNativeHelperError(
        "element_action_unsupported",
        `CUA action refused: ${JSON.stringify(facts)}`,
      );
    return facts;
  }

  private target(
    observed: Observation,
    elementId?: string,
  ): Record<string, unknown> {
    return {
      pid: observed.app.pid,
      window_id: observed.window.windowId,
      ...(elementId
        ? {
            element_token: observed.tokens.get(elementId),
            snapshot_id: observed.cuaSnapshot,
          }
        : {}),
    };
  }

  clickElement: ComputerUseNativeBackend["clickElement"] = async (args) => {
    const observed = await this.retained(args);
    return this.action("click", {
      ...this.target(observed, args.elementId),
      button: "left",
      action: "press",
      delivery_mode: this.delivery(args.foregroundRecovery),
    });
  };
  clickPoint: ComputerUseNativeBackend["clickPoint"] = async (args) => {
    const observed = await this.retained(args);
    if (
      args.screenshotSource !== "window" ||
      args.windowId !== observed.window.windowId ||
      args.screenshotWidth <= 0 ||
      args.screenshotHeight <= 0 ||
      !Number.isFinite(args.x) ||
      !Number.isFinite(args.y) ||
      args.x < 0 ||
      args.y < 0 ||
      args.x >= args.screenshotWidth ||
      args.y >= args.screenshotHeight
    )
      refuse("CUA click is outside the retained window image");
    const x = (args.x * observed.width) / args.screenshotWidth;
    const y = (args.y * observed.height) / args.screenshotHeight;
    // A display scale can change without changing logical window bounds. Refresh
    // the public window frame (which also invalidates old AX tokens) before using
    // CUA's per-window resize registry; never apply its Retina scale ourselves.
    await this.getAppState(args.app, `frame-${randomUUID()}`);
    const frame = this.observation;
    if (
      !frame ||
      frame.app.pid !== observed.app.pid ||
      frame.app.appPath !== observed.app.appPath ||
      frame.window.windowId !== observed.window.windowId ||
      JSON.stringify(frame.window.bounds) !==
        JSON.stringify(observed.window.bounds) ||
      frame.scale !== observed.scale ||
      frame.width !== observed.width ||
      frame.height !== observed.height
    )
      refuse(
        "CUA capture owner or geometry changed; re-observe before clicking",
      );
    const result = await this.action("click", {
      ...this.target(observed),
      x,
      y,
      button: args.button,
      count: args.clickCount,
      scope: "window",
      delivery_mode: this.delivery(args.foregroundRecovery),
    });
    return {
      ...result,
      screenX:
        observed.window.bounds.x +
        (x * observed.window.bounds.width) / observed.width,
      screenY:
        observed.window.bounds.y +
        (y * observed.window.bounds.height) / observed.height,
      coordinateSource: "retained_request_frame",
    };
  };
  setElementValue: ComputerUseNativeBackend["setElementValue"] = async (
    args,
  ) => {
    // Released structured rows cannot reliably identify browser address fields.
    if (
      /chrome|chromium|safari|edge|brave|firefox|arc|vivaldi|opera/i.test(
        args.app,
      )
    )
      refuse(
        "CUA browser set_value is unsupported: AX assignment does not prove address-bar navigation; use an explicit observed keyboard flow",
      );
    const observed = await this.retained(args);
    return this.action("set_value", {
      ...this.target(observed, args.elementId),
      value: args.value,
    });
  };
  performElementAction: ComputerUseNativeBackend["performElementAction"] =
    async (args) => {
      const actions: Readonly<Record<string, string>> = {
        AXPress: "press",
        AXConfirm: "confirm",
        AXShowMenu: "show_menu",
        AXPick: "pick",
        AXCancel: "cancel",
        AXOpen: "open",
        press: "press",
        confirm: "confirm",
        show_menu: "show_menu",
        pick: "pick",
        cancel: "cancel",
        open: "open",
      };
      const action = Object.hasOwn(actions, args.action)
        ? actions[args.action]
        : undefined;
      if (!action)
        refuse(
          "Unsupported CUA AX action; supported: AXPress, AXConfirm, AXShowMenu, AXPick, AXCancel, AXOpen",
        );
      const observed = await this.retained(args);
      return this.action("click", {
        ...this.target(observed, args.elementId),
        action,
        delivery_mode: "background",
      });
    };
  typeText: ComputerUseNativeBackend["typeText"] = async (args) => {
    const observed = await this.retained(args);
    return this.action("type_text", {
      ...this.target(observed),
      text: args.text,
      delay_ms: 0,
      delivery_mode: this.delivery(args.foregroundRecovery),
    });
  };
  pressKey: ComputerUseNativeBackend["pressKey"] = async (args) => {
    const key = normalizeKey(args.key);
    const observed = await this.retained(args);
    return {
      ...(await this.action("press_key", {
        ...this.target(observed),
        key: key.key,
        modifiers: key.modifiers,
        delivery_mode: this.delivery(args.foregroundRecovery),
      })),
      normalizedKey: key.normalizedKey,
    };
  };
  scrollElement: ComputerUseNativeBackend["scrollElement"] = async (args) => {
    const observed = await this.retained(args);
    return this.action("scroll", {
      ...this.target(observed),
      direction: args.direction,
      by: "page",
      amount: args.pages,
      delivery_mode: "background",
    });
  };
}
