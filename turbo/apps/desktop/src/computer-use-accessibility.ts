import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ComputerUsePermissionState } from "./computer-use-page";

const execFileAsync = promisify(execFile);

export const SUPPORTED_COMPUTER_USE_CAPABILITIES = [
  "apps.list",
  "app.state",
  "app.open",
  "element.click",
  "element.scroll",
  "element.set_value",
  "element.perform_action",
  "keyboard.type_text",
  "keyboard.press_key",
] as const;

export type ComputerUseCommandKind =
  (typeof SUPPORTED_COMPUTER_USE_CAPABILITIES)[number];

export interface ComputerUseCommand {
  readonly id: string;
  readonly kind: ComputerUseCommandKind;
  readonly payload: Record<string, unknown>;
}

interface AccessibilityElementSnapshot {
  readonly id: string;
  readonly role?: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly focused?: boolean;
  readonly enabled?: boolean;
  readonly actions?: readonly string[];
  readonly bounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly children?: readonly AccessibilityElementSnapshot[];
}

interface AccessibilityAppStateSnapshot {
  readonly app: string;
  readonly snapshotId: string;
  readonly elements: readonly AccessibilityElementSnapshot[];
}

export interface ComputerUseScreenshotCaptureRequest {
  readonly app: string;
  readonly windowNames: readonly string[];
}

export interface ComputerUseScreenshotCaptureResult {
  readonly dataUrl: string;
  readonly source: "window" | "screen";
  readonly sourceName: string;
  readonly width: number;
  readonly height: number;
}

type ComputerUseScreenshotCapture = (
  request: ComputerUseScreenshotCaptureRequest,
) => Promise<ComputerUseScreenshotCaptureResult>;

export interface ComputerUseCommandSuccess {
  readonly status: "succeeded";
  readonly result: Record<string, unknown>;
}

export interface ComputerUseCommandFailure {
  readonly status: "failed";
  readonly error: {
    readonly code:
      | "permission_denied"
      | "accessibility_unavailable"
      | "screen_recording_unavailable"
      | "unsupported_command";
    readonly message: string;
  };
}

export type ComputerUseCommandExecutionResult =
  | ComputerUseCommandSuccess
  | ComputerUseCommandFailure;

type RunJxa = (script: string) => Promise<string>;

interface ComputerUseCommandExecutionDependencies {
  readonly captureScreenshot: ComputerUseScreenshotCapture;
  readonly platform?: NodeJS.Platform;
  readonly runJxa?: RunJxa;
}

function payloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function snapshotId(): string {
  return `desktop_${Date.now().toString(36)}`;
}

function requireAccessibility(
  permissions: ComputerUsePermissionState,
  platform: NodeJS.Platform,
): ComputerUseCommandFailure | null {
  if (platform !== "darwin") {
    return {
      status: "failed",
      error: {
        code: "accessibility_unavailable",
        message: "Desktop Computer Use is currently implemented for macOS",
      },
    };
  }
  if (!permissions.accessibility) {
    return {
      status: "failed",
      error: {
        code: "permission_denied",
        message: "macOS Accessibility permission is required",
      },
    };
  }
  return null;
}

function requireScreenRecording(
  permissions: ComputerUsePermissionState,
): ComputerUseCommandFailure | null {
  if (!permissions.screenRecording) {
    return {
      status: "failed",
      error: {
        code: "screen_recording_unavailable",
        message: "macOS Screen Recording permission is required",
      },
    };
  }
  return null;
}

function jxaString(value: string): string {
  return JSON.stringify(value);
}

async function runJxa(script: string): Promise<string> {
  const { stdout } = await execFileAsync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    script,
  ]);
  return stdout.trim();
}

export function renderAccessibilityTree(
  snapshot: AccessibilityAppStateSnapshot,
): string {
  const lines = [`snapshot_id=${snapshot.snapshotId}`, `app=${snapshot.app}`];

  const visit = (
    element: AccessibilityElementSnapshot,
    depth: number,
  ): void => {
    const indent = "  ".repeat(depth);
    const label = [
      element.id,
      element.role,
      element.name ? `"${element.name}"` : null,
      element.value ? `value="${element.value}"` : null,
      element.actions && element.actions.length > 0
        ? `actions=${element.actions.join(",")}`
        : null,
    ]
      .filter((part): part is string => {
        return part !== null && part !== undefined;
      })
      .join(" ");
    lines.push(`${indent}${label}`);
    for (const child of element.children ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const element of snapshot.elements) {
    visit(element, 0);
  }
  return lines.join("\n");
}

function snapshotWindowNames(
  snapshot: AccessibilityAppStateSnapshot,
): string[] {
  return snapshot.elements
    .map((element) => {
      return element.name?.trim();
    })
    .filter((name): name is string => {
      return name !== undefined && name.length > 0;
    });
}

function buildComputerUseAppStateResult(
  snapshot: AccessibilityAppStateSnapshot,
  screenshot: ComputerUseScreenshotCaptureResult,
): Record<string, unknown> {
  return {
    ...snapshot,
    text: renderAccessibilityTree(snapshot),
    screenshot: screenshot.dataUrl,
    screenshotMimeType: "image/png",
    screenshotSource: screenshot.source,
    screenshotSourceName: screenshot.sourceName,
    screenshotWidth: screenshot.width,
    screenshotHeight: screenshot.height,
  };
}

function appStateScript(app: string, id: string): string {
  return `
const appName = ${jxaString(app)};
const snapshotId = ${jxaString(id)};
const systemEvents = Application("System Events");
function safeString(read) {
  try {
    const value = read();
    if (value === undefined || value === null) return undefined;
    return String(value);
  } catch (_error) {
    return undefined;
  }
}
function safeBool(read) {
  try {
    const value = read();
    return typeof value === "boolean" ? value : undefined;
  } catch (_error) {
    return undefined;
  }
}
function safeBounds(element) {
  try {
    const position = element.position();
    const size = element.size();
    return { x: position[0], y: position[1], width: size[0], height: size[1] };
  } catch (_error) {
    return undefined;
  }
}
function safeActions(element) {
  try {
    return element.actions().slice(0, 12).map((action) => String(action.name()));
  } catch (_error) {
    return [];
  }
}
function describe(element, id, depth) {
  const node = {
    id,
    role: safeString(() => element.role()),
    name: safeString(() => element.name()),
    value: safeString(() => element.value()),
    description: safeString(() => element.description()),
    focused: safeBool(() => element.focused()),
    enabled: safeBool(() => element.enabled()),
    actions: safeActions(element),
    bounds: safeBounds(element),
    children: [],
  };
  if (depth <= 0) return node;
  let children = [];
  try {
    children = element.uiElements().slice(0, 80);
  } catch (_error) {
    children = [];
  }
  node.children = children.map((child, index) => describe(child, id + ".e" + index, depth - 1));
  return node;
}
const processes = systemEvents.processes.whose({ name: appName })();
if (processes.length === 0) {
  JSON.stringify({ app: appName, snapshotId, elements: [] });
} else {
  const process = processes[0];
  process.frontmost = true;
  const windows = process.windows().slice(0, 8);
  JSON.stringify({
    app: appName,
    snapshotId,
    elements: windows.map((window, index) => describe(window, "w" + index, 2)),
  });
}
`;
}

function resolveElementScript(app: string, elementId: string): string {
  return `
const appName = ${jxaString(app)};
const elementId = ${jxaString(elementId)};
const systemEvents = Application("System Events");
function resolve(process, id) {
  const parts = id.split(".");
  let current = null;
  for (const part of parts) {
    const index = Number(part.slice(1));
    if (part.startsWith("w")) {
      current = process.windows()[index];
    } else if (part.startsWith("e") && current) {
      current = current.uiElements()[index];
    } else {
      throw new Error("Invalid element id: " + id);
    }
  }
  if (!current) throw new Error("Element not found: " + id);
  return current;
}
const processes = systemEvents.processes.whose({ name: appName })();
if (processes.length === 0) throw new Error("App is not running: " + appName);
const element = resolve(processes[0], elementId);
`;
}

async function listApps(): Promise<ComputerUseCommandSuccess> {
  const output = await runJxa(`
const systemEvents = Application("System Events");
const apps = systemEvents.applicationProcesses.whose({ backgroundOnly: false })()
  .map((app) => String(app.name()))
  .sort();
JSON.stringify(apps);
`);
  const apps = JSON.parse(output) as string[];
  return { status: "succeeded", result: { apps, text: apps.join("\n") } };
}

async function getAppState(
  app: string,
  runJxaCommand: RunJxa,
  captureScreenshot: ComputerUseScreenshotCapture,
): Promise<ComputerUseCommandExecutionResult> {
  const id = snapshotId();
  const output = await runJxaCommand(appStateScript(app, id));
  const snapshot = JSON.parse(output) as AccessibilityAppStateSnapshot;
  let screenshot: ComputerUseScreenshotCaptureResult;
  try {
    screenshot = await captureScreenshot({
      app,
      windowNames: snapshotWindowNames(snapshot),
    });
  } catch (error) {
    return {
      status: "failed",
      error: {
        code: "screen_recording_unavailable",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  return {
    status: "succeeded",
    result: buildComputerUseAppStateResult(snapshot, screenshot),
  };
}

async function openApp(app: string): Promise<ComputerUseCommandSuccess> {
  await runJxa(`Application(${jxaString(app)}).activate();`);
  return { status: "succeeded", result: { app, text: `Opened ${app}` } };
}

async function clickElement(
  app: string,
  elementId: string | null,
  x: number | null,
  y: number | null,
): Promise<ComputerUseCommandExecutionResult> {
  if (elementId) {
    await runJxa(`
${resolveElementScript(app, elementId)}
element.click();
`);
    return {
      status: "succeeded",
      result: { app, elementId, text: `Clicked ${elementId}` },
    };
  }
  if (x !== null && y !== null) {
    await runJxa(`
const systemEvents = Application("System Events");
systemEvents.click({ at: [${x}, ${y}] });
`);
    return {
      status: "succeeded",
      result: { app, x, y, text: `Clicked ${x},${y}` },
    };
  }
  return {
    status: "failed",
    error: {
      code: "unsupported_command",
      message: "element.click requires an element id or coordinates",
    },
  };
}

async function setElementValue(
  app: string,
  elementId: string,
  value: string,
): Promise<ComputerUseCommandSuccess> {
  await runJxa(`
${resolveElementScript(app, elementId)}
element.value = ${jxaString(value)};
`);
  return {
    status: "succeeded",
    result: { app, elementId, text: `Set ${elementId}` },
  };
}

async function performElementAction(
  app: string,
  elementId: string,
  action: string,
): Promise<ComputerUseCommandSuccess> {
  await runJxa(`
${resolveElementScript(app, elementId)}
element.actions.byName(${jxaString(action)}).perform();
`);
  return {
    status: "succeeded",
    result: { app, elementId, action, text: `Performed ${action}` },
  };
}

async function typeText(
  app: string,
  text: string,
): Promise<ComputerUseCommandSuccess> {
  await runJxa(`
Application(${jxaString(app)}).activate();
Application("System Events").keystroke(${jxaString(text)});
`);
  return { status: "succeeded", result: { app, text: "Typed text" } };
}

async function pressKey(
  app: string,
  key: string,
): Promise<ComputerUseCommandSuccess> {
  await runJxa(`
Application(${jxaString(app)}).activate();
Application("System Events").keystroke(${jxaString(key)});
`);
  return { status: "succeeded", result: { app, key, text: `Pressed ${key}` } };
}

async function scrollElement(
  app: string,
  elementId: string,
  direction: string,
  pages: number,
): Promise<ComputerUseCommandSuccess> {
  const axis =
    direction === "left" || direction === "right"
      ? "AXHorizontalScrollBar"
      : "AXVerticalScrollBar";
  const sign = direction === "up" || direction === "left" ? -1 : 1;
  await runJxa(`
${resolveElementScript(app, elementId)}
const scrollBars = element.uiElements.whose({ role: ${jxaString(axis)} })();
if (scrollBars.length > 0) {
  const scrollBar = scrollBars[0];
  scrollBar.value = Number(scrollBar.value()) + ${sign * pages};
}
`);
  return {
    status: "succeeded",
    result: { app, elementId, direction, pages, text: `Scrolled ${elementId}` },
  };
}

function missingField(field: string): ComputerUseCommandFailure {
  return {
    status: "failed",
    error: {
      code: "unsupported_command",
      message: `Missing required payload field: ${field}`,
    },
  };
}

function payloadNumber(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = payload[key];
  return typeof value === "number" ? value : null;
}

export async function executeComputerUseCommand(
  command: ComputerUseCommand,
  permissions: ComputerUsePermissionState,
  dependencies: ComputerUseCommandExecutionDependencies,
): Promise<ComputerUseCommandExecutionResult> {
  const permissionError = requireAccessibility(
    permissions,
    dependencies.platform ?? process.platform,
  );
  if (permissionError) {
    return permissionError;
  }

  try {
    const app = payloadString(command.payload, "app");
    if (command.kind === "apps.list") {
      return await listApps();
    }
    if (!app) {
      return missingField("app");
    }
    if (command.kind === "app.state") {
      const screenRecordingError = requireScreenRecording(permissions);
      if (screenRecordingError) {
        return screenRecordingError;
      }
      return await getAppState(
        app,
        dependencies.runJxa ?? runJxa,
        dependencies.captureScreenshot,
      );
    }
    if (command.kind === "app.open") {
      return await openApp(app);
    }
    if (command.kind === "element.click") {
      return await clickElement(
        app,
        payloadString(command.payload, "elementId"),
        payloadNumber(command.payload, "x"),
        payloadNumber(command.payload, "y"),
      );
    }
    if (command.kind === "element.scroll") {
      const elementId = payloadString(command.payload, "elementId");
      const direction = payloadString(command.payload, "direction");
      if (!elementId) {
        return missingField("elementId");
      }
      if (!direction) {
        return missingField("direction");
      }
      return await scrollElement(
        app,
        elementId,
        direction,
        payloadNumber(command.payload, "pages") ?? 1,
      );
    }
    if (command.kind === "element.set_value") {
      const elementId = payloadString(command.payload, "elementId");
      const value = payloadString(command.payload, "value");
      if (!elementId) {
        return missingField("elementId");
      }
      if (!value) {
        return missingField("value");
      }
      return await setElementValue(app, elementId, value);
    }
    if (command.kind === "element.perform_action") {
      const elementId = payloadString(command.payload, "elementId");
      const action = payloadString(command.payload, "action");
      if (!elementId) {
        return missingField("elementId");
      }
      if (!action) {
        return missingField("action");
      }
      return await performElementAction(app, elementId, action);
    }
    if (command.kind === "keyboard.type_text") {
      const text = payloadString(command.payload, "text");
      return text ? await typeText(app, text) : missingField("text");
    }
    if (command.kind === "keyboard.press_key") {
      const key = payloadString(command.payload, "key");
      return key ? await pressKey(app, key) : missingField("key");
    }
  } catch (error) {
    return {
      status: "failed",
      error: {
        code: "accessibility_unavailable",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  return {
    status: "failed",
    error: {
      code: "unsupported_command",
      message: `Unsupported command: ${command.kind}`,
    },
  };
}
